import type { FileData } from "@/types/FileData";

type TreeNode = Pick<FileData, "id" | "name" | "parentId">;

/** Maps every file id to its path inside the room, e.g. "src/utils/math.js". */
export function buildPathMap(files: TreeNode[]): Map<string, string> {
  const byId = new Map(files.map((file) => [file.id, file]));
  const paths = new Map<string, string>();

  const resolve = (id: string, depth: number): string => {
    const cached = paths.get(id);
    if (cached !== undefined) return cached;
    const file = byId.get(id)!;
    const parent =
      file.parentId && byId.has(file.parentId) && depth < 64
        ? `${resolve(file.parentId, depth + 1)}/`
        : "";
    const fullPath = `${parent}${file.name}`;
    paths.set(id, fullPath);
    return fullPath;
  };

  for (const file of files) resolve(file.id, 0);
  return paths;
}

/** Resolves a reference like "./css/site.css" relative to another file. */
export function resolveRelativePath(fromPath: string, reference: string): string {
  const clean = reference.split(/[?#]/)[0];
  const segments = clean.startsWith("/")
    ? []
    : fromPath.split("/").slice(0, -1);

  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

export function isExternalUrl(reference: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(reference);
}
