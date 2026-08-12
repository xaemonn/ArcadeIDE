import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { bearerToken, verifyRoomToken, type RoomClaims } from "./auth.js";
import { config, isAllowedOrigin } from "./config.js";
import { checkProject } from "./exec/checks.js";
import { BadRequestError, parseProject, writeProject } from "./exec/files.js";
import {
  availableLanguages,
  executeProject,
  isLanguage,
  LANGUAGES,
} from "./exec/languages.js";
import { bundlePreview } from "./exec/preview.js";
import { getSandbox, Semaphore } from "./exec/sandbox.js";

type AuthedRequest = Request & { claims?: RoomClaims };

const startedAt = Date.now();
const slots = new Semaphore(config.exec.concurrency, config.exec.queueLimit);
const recentRuns = new Map<string, number[]>();

// Live preview rebuilds while people type, so bundling gets a larger budget
// than running programs.
const PREVIEW_RATE_MULTIPLIER = 4;

function rateLimited(userId: string, kind: "run" | "preview"): boolean {
  const key = `${kind}:${userId}`;
  const limit =
    config.exec.rateLimitPerMinute * (kind === "preview" ? PREVIEW_RATE_MULTIPLIER : 1);
  const now = Date.now();
  const windowStart = now - 60_000;
  const runs = (recentRuns.get(key) ?? []).filter((t) => t > windowStart);
  if (runs.length >= limit) {
    recentRuns.set(key, runs);
    return true;
  }
  runs.push(now);
  recentRuns.set(key, runs);
  return false;
}

setInterval(() => {
  const windowStart = Date.now() - 60_000;
  for (const [key, runs] of recentRuns) {
    if (runs.every((t) => t <= windowStart)) recentRuns.delete(key);
  }
}, 60_000).unref();

async function requireRoomToken(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    req.claims = await verifyRoomToken(bearerToken(req.headers.authorization));
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized", stderr: "Unauthorized: please reload the room." });
  }
}

export function createHttpApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    cors({
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    })
  );

  app.get("/", (_req, res) => {
    res.json({ service: "arcadeide-server", status: "ok" });
  });

  app.get("/health", (_req, res) => {
    const sandbox = getSandbox();
    res.json({
      status: "ok",
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      sandbox: { mode: sandbox.mode, network: sandbox.network, rlimits: sandbox.prlimit },
      languages: availableLanguages(),
      queue: slots.pending,
    });
  });

  app.post(
    "/api/exec",
    express.json({ limit: "4mb" }),
    requireRoomToken,
    async (req: AuthedRequest, res: Response) => {
      const { language, files, entry, mode, stdin } = req.body ?? {};

      if (rateLimited(req.claims!.user.id, mode === "preview" ? "preview" : "run")) {
        return res.status(429).json({
          error: "Too many requests. Please wait a moment.",
          stderr: "You are running code too often. Please wait a moment.",
        });
      }

      if (mode === "preview") {
        return res.json(await bundlePreview(files, entry));
      }

      if (!isLanguage(language)) {
        return res.status(400).json({
          error: `Unsupported language. Supported: ${LANGUAGES.join(", ")}`,
          stderr: `Cannot run this file type. Supported: ${LANGUAGES.join(", ")}.`,
        });
      }

      const sandbox = getSandbox();
      if (sandbox.mode === "disabled") {
        return res.status(503).json({
          error: "Code execution is disabled",
          stderr: `Code execution is disabled on this server (${sandbox.reason}).`,
        });
      }

      let project: ReturnType<typeof parseProject>;
      try {
        project = parseProject(files, entry);
      } catch (error) {
        if (error instanceof BadRequestError) {
          return res.status(400).json({ error: error.message, stderr: error.message });
        }
        throw error;
      }

      const issues = checkProject(language, project.files);
      if (issues.length > 0) {
        return res.json({
          stdout: "",
          stderr: `Blocked by the sandbox policy:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
          exitCode: 1,
          blocked: true,
        });
      }

      let release: () => void;
      try {
        release = await slots.acquire();
      } catch {
        return res.status(503).json({
          error: "Server busy",
          stderr: "The code runner is busy. Please try again in a few seconds.",
        });
      }

      let dir: string | undefined;
      try {
        await mkdir(config.exec.workDir, { recursive: true });
        dir = await mkdtemp(path.join(config.exec.workDir, "run-"));
        const owner =
          sandbox.mode === "isolated" ? { uid: sandbox.uid, gid: sandbox.gid } : undefined;
        await writeProject(dir, project.files, owner);

        const result = await executeProject(
          language,
          dir,
          project.entry,
          project.files,
          typeof stdin === "string" ? stdin.slice(0, 64 * 1024) : undefined
        );
        res.json(result);
      } finally {
        release();
        if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number })?.status;
    if (status && status >= 400 && status < 500) {
      return res.status(status).json({ error: "Bad request", stderr: "Bad request." });
    }
    console.error("[http] unhandled error", error);
    res.status(500).json({ error: "Internal server error", stderr: "Internal server error." });
  });

  return app;
}
