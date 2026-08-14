import { spawn } from "node:child_process";
import { config } from "../config.js";

/**
 * Process isolation for user code.
 *
 * "isolated":    the server runs as root inside its container and user code
 *                runs as an unprivileged uid with rlimits (prlimit) applied,
 *                and in its own network namespace when the host allows it.
 * "unsandboxed": code runs as the server's own user. Fine for local
 *                development, never for a public deployment.
 * "disabled":    execution is refused.
 */
export interface SandboxInfo {
  mode: "isolated" | "unsandboxed" | "disabled";
  uid?: number;
  gid?: number;
  prlimit: boolean;
  network: "blocked" | "allowed";
  reason?: string;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /** Address-space limit. Leave unset for JVMs and V8, which reserve a lot. */
  memoryBytes?: number;
  stdin?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

const MAX_PROCESSES = 256;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

let sandbox: SandboxInfo = {
  mode: "disabled",
  prlimit: false,
  network: "allowed",
  reason: "not initialised",
};

export function getSandbox(): SandboxInfo {
  return sandbox;
}

function probe(
  command: string,
  args: string[],
  ids?: { uid?: number; gid?: number }
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", ...ids });
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function detectSandbox(): Promise<SandboxInfo> {
  const { uid, gid, allowUnsandboxed } = config.exec;
  const fallback: SandboxInfo["mode"] =
    allowUnsandboxed || !config.isProduction ? "unsandboxed" : "disabled";

  if (process.platform !== "linux") {
    sandbox = {
      mode: fallback,
      prlimit: false,
      network: "allowed",
      reason: "uid isolation is only available on Linux",
    };
    return sandbox;
  }

  const isRoot = process.getuid?.() === 0;
  const ids =
    isRoot && uid !== undefined ? { uid, gid: gid ?? uid } : undefined;
  const canDropPrivileges = ids ? await probe("true", [], ids) : false;
  const prlimit = await probe("prlimit", ["--nofile=64", "--", "true"], ids);
  // Needs unprivileged user namespaces, which many container hosts block.
  const netns = await probe("unshare", ["-rn", "--", "true"], ids);

  if (canDropPrivileges) {
    sandbox = {
      mode: "isolated",
      ...ids,
      prlimit,
      network: netns ? "blocked" : "allowed",
    };
  } else {
    sandbox = {
      mode: fallback,
      prlimit,
      network: netns ? "blocked" : "allowed",
      reason: isRoot
        ? "EXEC_UID is not set or the host does not allow setuid"
        : "server is not running as root",
    };
  }
  return sandbox;
}

function buildCommand(options: RunOptions): { command: string; args: string[] } {
  let command = options.command;
  let args = options.args;

  if (sandbox.prlimit) {
    const cpuSeconds = Math.ceil(options.timeoutMs / 1000) + 1;
    const limits = [
      `--cpu=${cpuSeconds}`,
      `--nproc=${MAX_PROCESSES}`,
      `--fsize=${MAX_FILE_BYTES}`,
      "--nofile=256",
      "--core=0",
    ];
    if (options.memoryBytes) limits.push(`--as=${options.memoryBytes}`);
    args = [...limits, "--", command, ...args];
    command = "prlimit";
  }

  if (sandbox.network === "blocked") {
    args = ["-rn", "--", command, ...args];
    command = "unshare";
  }

  return { command, args };
}

export function runProcess(options: RunOptions): Promise<RunResult> {
  const { command, args } = buildCommand(options);
  const maxBytes = config.exec.maxOutputBytes;
  const started = Date.now();
  const isWindows = process.platform === "win32";

  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: options.cwd,
        TMPDIR: options.cwd,
        LANG: "C.UTF-8",
        ...(isWindows ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
        ...options.env,
      },
      uid: sandbox.mode === "isolated" ? sandbox.uid : undefined,
      gid: sandbox.mode === "isolated" ? sandbox.gid : undefined,
      // Own process group so the whole tree can be killed on timeout.
      detached: !isWindows,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killTree = () => {
      try {
        if (!isWindows && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - outputBytes;
      if (chunk.length > remaining) {
        target.push(chunk.subarray(0, remaining));
        outputBytes = maxBytes;
        truncated = true;
        killTree();
        return;
      }
      target.push(chunk);
      outputBytes += chunk.length;
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    };

    child.on("error", (err) => {
      stderr.push(Buffer.from(`Failed to start process: ${err.message}\n`));
      finish(null, null);
    });
    child.on("close", finish);

    child.stdin.on("error", () => {
      // The program may exit without reading stdin.
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** Limits how many programs run at once and how many may wait. */
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly queueLimit: number
  ) {}

  get pending() {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
    } else {
      if (this.waiting.length >= this.queueLimit) {
        throw new Error("Execution queue is full");
      }
      // The releasing caller hands its slot over directly.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
