const PALETTE = [
  "#f97316",
  "#22c55e",
  "#3b82f6",
  "#e11d48",
  "#a855f7",
  "#14b8a6",
  "#eab308",
  "#ec4899",
];

/** Stable color per user, used for remote cursors and presence. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
