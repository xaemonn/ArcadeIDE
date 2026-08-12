"use client";

export const BACKEND_URL = (
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000"
).replace(/\/$/, "");

const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Returns a cached room token, fetching a fresh one shortly before expiry. */
export async function getRoomToken(slug: string, forceRefresh = false): Promise<string> {
  const cached = tokens.get(slug);
  if (!forceRefresh && cached && cached.expiresAt - Date.now() > 60_000) {
    return cached.token;
  }

  const res = await fetch(`/api/room/${encodeURIComponent(slug)}/token`, {
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.token !== "string") {
    throw new Error(data.error || "Could not authorize with the realtime server");
  }
  tokens.set(slug, { token: data.token, expiresAt: Date.parse(data.expiresAt) });
  return data.token;
}

export function forgetRoomToken(slug: string) {
  tokens.delete(slug);
}

export interface ExecResponse {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  code?: string;
  packageJson?: { dependencies?: Record<string, string> };
  error?: string;
}

/** POSTs to the backend's /api/exec with the room token, retrying once on 401. */
export async function execOnBackend(slug: string, body: Record<string, unknown>) {
  const send = async (token: string) =>
    fetch(`${BACKEND_URL}/api/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

  let res = await send(await getRoomToken(slug));
  if (res.status === 401) res = await send(await getRoomToken(slug, true));
  const data = (await res.json().catch(() => ({}))) as ExecResponse;
  return { ok: res.ok, status: res.status, data };
}
