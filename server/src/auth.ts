import { jwtVerify } from "jose";
import { config } from "./config.js";

// Must match src/lib/roomToken.ts in the Next.js app.
export const TOKEN_ISSUER = "arcadeide-web";
export const TOKEN_AUDIENCE = "arcadeide-backend";

export interface RoomUser {
  id: string;
  name: string;
  image: string | null;
}

export interface RoomClaims {
  roomId: string;
  user: RoomUser;
}

let secretKey: Uint8Array | null = null;

function getKey(): Uint8Array {
  secretKey ??= new TextEncoder().encode(config.roomTokenSecret);
  return secretKey;
}

export async function verifyRoomToken(token: unknown): Promise<RoomClaims> {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Missing room token");
  }

  const { payload } = await jwtVerify(token, getKey(), {
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    algorithms: ["HS256"],
  });

  if (typeof payload.sub !== "string" || typeof payload.roomId !== "string") {
    throw new Error("Malformed room token");
  }

  return {
    roomId: payload.roomId,
    user: {
      id: payload.sub,
      name: typeof payload.name === "string" ? payload.name : "Anonymous",
      image: typeof payload.picture === "string" ? payload.picture : null,
    },
  };
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}
