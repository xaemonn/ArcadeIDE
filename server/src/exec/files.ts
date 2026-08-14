import { chown, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export class BadRequestError extends Error {}

/** Normalises a project path and rejects anything escaping the project. */
export function normalizeProjectPath(raw: string): string {
  const cleaned = path.posix.normalize(
    raw.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "")
  );
  if (
    !cleaned ||
    cleaned === "." ||
    cleaned.includes("\0") ||
    cleaned.split("/").some((segment) => segment === "..")
  ) {
    throw new BadRequestError(`Invalid file path: ${raw}`);
  }
  return cleaned;
}

export function parseProject(
  files: unknown,
  entry: unknown
): { files: Map<string, string>; entry: string } {
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new BadRequestError("`files` must be an object of path -> content");
  }
  if (typeof entry !== "string" || !entry) {
    throw new BadRequestError("`entry` is required");
  }

  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > MAX_FILES) {
    throw new BadRequestError(`Too many files (max ${MAX_FILES})`);
  }

  const project = new Map<string, string>();
  let totalBytes = 0;
  for (const [rawPath, content] of entries) {
    if (typeof content !== "string") continue;
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new BadRequestError("Project is too large to run (max 2 MB)");
    }
    project.set(normalizeProjectPath(rawPath), content);
  }

  const entryPath = normalizeProjectPath(entry);
  if (!project.has(entryPath)) {
    throw new BadRequestError(`Entry file "${entry}" was not sent`);
  }
  return { files: project, entry: entryPath };
}

export async function writeProject(
  root: string,
  files: Map<string, string>,
  owner?: { uid?: number; gid?: number }
) {
  const createdDirs = new Set<string>();
  for (const [relativePath, content] of files) {
    const target = path.join(root, ...relativePath.split("/"));
    const dir = path.dirname(target);
    if (!createdDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      createdDirs.add(dir);
    }
    await writeFile(target, content);
    if (owner?.uid !== undefined) await chown(target, owner.uid, owner.gid ?? owner.uid);
  }
  if (owner?.uid !== undefined) {
    for (const dir of createdDirs) {
      await chown(dir, owner.uid, owner.gid ?? owner.uid);
    }
    await chown(root, owner.uid, owner.gid ?? owner.uid);
  }
}
