import { spawn } from "node:child_process";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { config } from "../config.js";
import { runProcess, type RunResult } from "./sandbox.js";

export const LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "c",
  "cpp",
  "java",
] as const;

export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  phase: "compile" | "run";
}

interface Toolchain {
  python?: string;
  gcc?: string;
  gxx?: string;
  javac?: string;
  java?: string;
}

const MB = 1024 * 1024;
const isWindows = process.platform === "win32";
let toolchain: Toolchain = {};

function works(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
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

async function firstWorking(candidates: string[], args: string[]) {
  for (const candidate of candidates) {
    if (await works(candidate, args)) return candidate;
  }
  return undefined;
}

export async function detectToolchain(): Promise<Record<Language, boolean>> {
  const [python, gcc, gxx, javac, java] = await Promise.all([
    firstWorking(["python3", "python"], ["--version"]),
    firstWorking(["gcc"], ["--version"]),
    firstWorking(["g++"], ["--version"]),
    firstWorking(["javac"], ["-version"]),
    firstWorking(["java"], ["-version"]),
  ]);
  toolchain = { python, gcc, gxx, javac, java };
  return availableLanguages();
}

export function availableLanguages(): Record<Language, boolean> {
  return {
    javascript: true,
    typescript: true,
    python: Boolean(toolchain.python),
    c: Boolean(toolchain.gcc),
    cpp: Boolean(toolchain.gxx),
    java: Boolean(toolchain.javac && toolchain.java),
  };
}

const LANGUAGE_NAMES: Record<Language, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  c: "C",
  cpp: "C++",
  java: "Java",
};

function toExecResult(result: RunResult, phase: ExecResult["phase"]): ExecResult {
  let stderr = result.stderr;
  const notes: string[] = [];
  if (result.timedOut) {
    notes.push(`Time limit exceeded (${config.exec.runTimeoutMs / 1000}s).`);
  } else if (result.signal === "SIGXCPU") {
    notes.push("CPU time limit exceeded.");
  } else if (result.signal === "SIGSEGV") {
    notes.push("Segmentation fault.");
  } else if (result.signal === "SIGKILL" && !result.truncated) {
    notes.push("Process was killed (likely out of memory).");
  } else if (result.signal) {
    notes.push(`Process terminated by ${result.signal}.`);
  }
  if (result.truncated) notes.push("Output was truncated.");
  if (notes.length) stderr = `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${notes.join("\n")}`;

  return {
    stdout: result.stdout,
    stderr,
    exitCode: result.exitCode ?? (result.signal ? 137 : null),
    timedOut: result.timedOut,
    truncated: result.truncated,
    durationMs: result.durationMs,
    phase,
  };
}

function failure(message: string, phase: ExecResult["phase"] = "compile"): ExecResult {
  return {
    stdout: "",
    stderr: message,
    exitCode: 1,
    timedOut: false,
    truncated: false,
    durationMs: 0,
    phase,
  };
}

/** esbuild runs with server privileges, so keep imports inside the project. */
function confineTo(root: string): Plugin {
  return {
    name: "confine-to-project",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^(\.|\/|[a-zA-Z]:)/ }, (args) => {
        const resolved = path.resolve(args.resolveDir || root, args.path);
        const relative = path.relative(root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return { errors: [{ text: `Cannot import "${args.path}" from outside the project` }] };
        }
        return undefined;
      });
    },
  };
}

const toNative = (relativePath: string) => relativePath.split("/").join(path.sep);

function sourcesFor(
  files: Map<string, string>,
  entry: string,
  pattern: RegExp
): string[] {
  // Link the entry plus every other source file that does not define its own
  // main(), so multi-file programs work while stray scratch files are ignored.
  const sources = [entry];
  for (const [filePath, content] of files) {
    if (filePath === entry || !pattern.test(filePath)) continue;
    if (/\bmain\s*\(/.test(content)) continue;
    sources.push(filePath);
  }
  return sources.map(toNative);
}

async function runNative(
  compiler: string,
  flags: string[],
  sources: string[],
  dir: string,
  stdin?: string
): Promise<ExecResult> {
  const binary = isWindows ? "program.exe" : "program";
  const compile = await runProcess({
    command: compiler,
    args: [...flags, "-o", binary, ...sources, "-lm"],
    cwd: dir,
    timeoutMs: config.exec.compileTimeoutMs,
    memoryBytes: 1024 * MB,
  });
  if (compile.exitCode !== 0) return toExecResult(compile, "compile");

  const run = await runProcess({
    command: path.join(dir, binary),
    args: [],
    cwd: dir,
    timeoutMs: config.exec.runTimeoutMs,
    memoryBytes: 512 * MB,
    stdin,
  });
  return toExecResult(run, "run");
}

export async function executeProject(
  language: Language,
  dir: string,
  entry: string,
  files: Map<string, string>,
  stdin?: string
): Promise<ExecResult> {
  if (!availableLanguages()[language]) {
    return failure(`${LANGUAGE_NAMES[language]} is not installed on this server.`);
  }

  const timeoutMs = config.exec.runTimeoutMs;

  switch (language) {
    case "javascript": {
      const run = await runProcess({
        command: process.execPath,
        args: ["--max-old-space-size=256", toNative(entry)],
        cwd: dir,
        timeoutMs,
        stdin,
      });
      return toExecResult(run, "run");
    }

    case "typescript": {
      const outfile = ".arcade-main.mjs";
      try {
        await build({
          entryPoints: [path.join(dir, toNative(entry))],
          outfile: path.join(dir, outfile),
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node20",
          packages: "external",
          sourcemap: "inline",
          logLevel: "silent",
          plugins: [confineTo(dir)],
        });
      } catch (error) {
        return failure(formatBuildError(error, dir));
      }
      const run = await runProcess({
        command: process.execPath,
        args: ["--enable-source-maps", "--max-old-space-size=256", outfile],
        cwd: dir,
        timeoutMs,
        stdin,
      });
      return toExecResult(run, "run");
    }

    case "python": {
      const run = await runProcess({
        command: toolchain.python!,
        args: ["-u", toNative(entry)],
        cwd: dir,
        timeoutMs,
        memoryBytes: 512 * MB,
        stdin,
        env: { PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
      });
      return toExecResult(run, "run");
    }

    case "c":
      return runNative(
        toolchain.gcc!,
        ["-std=gnu11", "-O2", "-pipe", "-Wall"],
        sourcesFor(files, entry, /\.c$/),
        dir,
        stdin
      );

    case "cpp":
      return runNative(
        toolchain.gxx!,
        ["-std=gnu++17", "-O2", "-pipe", "-Wall"],
        sourcesFor(files, entry, /\.(cc|cpp|cxx)$/),
        dir,
        stdin
      );

    case "java": {
      const classDir = ".arcade-classes";
      const sources = [...files.keys()].filter((f) => f.endsWith(".java")).map(toNative);
      const compile = await runProcess({
        command: toolchain.javac!,
        args: ["-J-Xmx512m", "-encoding", "UTF-8", "-d", classDir, ...sources],
        cwd: dir,
        timeoutMs: config.exec.compileTimeoutMs,
      });
      if (compile.exitCode !== 0) return toExecResult(compile, "compile");

      const source = files.get(entry) ?? "";
      const pkg = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
      const className = path.posix.basename(entry, ".java");
      const run = await runProcess({
        command: toolchain.java!,
        args: [
          "-Xmx256m",
          "-Xss16m",
          "-XX:+UseSerialGC",
          "-XX:TieredStopAtLevel=1",
          "-cp",
          classDir,
          pkg ? `${pkg}.${className}` : className,
        ],
        cwd: dir,
        timeoutMs,
        stdin,
      });
      return toExecResult(run, "run");
    }
  }
}

export function formatBuildError(error: unknown, rootDir?: string): string {
  const errors = (error as { errors?: Array<{ text: string; location?: { file: string; line: number; column: number; lineText: string } | null }> })
    ?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return error instanceof Error ? error.message : String(error);
  }
  return errors
    .map(({ text, location }) => {
      if (!location) return `error: ${text}`;
      let file = location.file;
      if (rootDir && path.isAbsolute(file)) file = path.relative(rootDir, file);
      file = file.replace(/^project:/, "").split(path.sep).join("/");
      return `${file}:${location.line}:${location.column + 1}: error: ${text}\n    ${location.lineText}`;
    })
    .join("\n");
}
