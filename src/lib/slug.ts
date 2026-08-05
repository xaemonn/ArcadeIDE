import { randomBytes } from "node:crypto";

/** URL-safe, globally unique room slug such as "my-project-k3f9q2". */
export function createRoomSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "room";
  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  return `${base}-${suffix}`;
}
