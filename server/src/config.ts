import os from "node:os";
import path from "node:path";

const DEV_TOKEN_SECRET = "arcadeide-dev-secret-change-me";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const isProduction = process.env.NODE_ENV === "production";

export const config = {
  port: positiveNumber(process.env.PORT, 4000),
  isProduction,
  // Comma separated list. Entries may contain a single "*" wildcard for one
  // DNS label, e.g. "https://arcadeide-*.vercel.app".
  clientOrigins: (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean),
  roomTokenSecret:
    process.env.ROOM_TOKEN_SECRET || (isProduction ? "" : DEV_TOKEN_SECRET),
  exec: {
    concurrency: positiveNumber(process.env.EXEC_CONCURRENCY, 2),
    queueLimit: positiveNumber(process.env.EXEC_QUEUE_LIMIT, 20),
    runTimeoutMs: positiveNumber(process.env.EXEC_TIMEOUT_MS, 10_000),
    compileTimeoutMs: positiveNumber(process.env.EXEC_COMPILE_TIMEOUT_MS, 30_000),
    maxOutputBytes: positiveNumber(process.env.EXEC_MAX_OUTPUT_BYTES, 64 * 1024),
    rateLimitPerMinute: positiveNumber(process.env.EXEC_RATE_LIMIT_PER_MINUTE, 30),
    workDir:
      process.env.EXEC_WORKDIR || path.join(os.tmpdir(), "arcadeide-runs"),
    // When the server runs as root, user code is executed as this uid/gid.
    uid: optionalInt(process.env.EXEC_UID),
    gid: optionalInt(process.env.EXEC_GID),
    // Allows running user code without uid isolation in production.
    // Only enable this on a throwaway machine.
    allowUnsandboxed: process.env.ALLOW_UNSANDBOXED_EXEC === "true",
  },
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const originMatchers = config.clientOrigins.map((allowed) => {
  if (allowed === "*") return () => true;
  if (!allowed.includes("*")) return (origin: string) => origin === allowed;
  const pattern = new RegExp(
    "^" + allowed.split("*").map(escapeRegex).join("[a-z0-9-]+") + "$",
    "i"
  );
  return (origin: string) => pattern.test(origin);
});

export function isAllowedOrigin(origin: string | undefined): boolean {
  // Requests without an Origin header (curl, server-to-server) still need a
  // valid room token, so CORS is not the security boundary for them.
  if (!origin) return true;
  return originMatchers.some((matches) => matches(origin));
}

export function assertConfig(): void {
  if (!config.roomTokenSecret) {
    throw new Error(
      "ROOM_TOKEN_SECRET is not set. Use the same value as the Next.js app."
    );
  }
  if (!process.env.ROOM_TOKEN_SECRET) {
    console.warn(
      "[config] ROOM_TOKEN_SECRET not set, using the development default."
    );
  }
}
