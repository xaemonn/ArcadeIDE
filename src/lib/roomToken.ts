import { SignJWT } from "jose";

// Must match server/src/auth.ts.
const TOKEN_ISSUER = "arcadeide-web";
const TOKEN_AUDIENCE = "arcadeide-backend";
const TOKEN_TTL_SECONDS = 2 * 60 * 60;
const DEV_SECRET = "arcadeide-dev-secret-change-me";

function getSecret(): Uint8Array {
  const secret =
    process.env.ROOM_TOKEN_SECRET ||
    (process.env.NODE_ENV !== "production" ? DEV_SECRET : "");
  if (!secret) {
    throw new Error("ROOM_TOKEN_SECRET is not configured");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Short-lived token proving the user may join a room. The realtime/exec
 * backend verifies it with the same shared secret, so it never needs
 * database access of its own.
 */
export async function signRoomToken(input: {
  userId: string;
  name: string;
  image: string | null;
  roomId: string;
}) {
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
  const token = await new SignJWT({
    roomId: input.roomId,
    name: input.name,
    picture: input.image,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getSecret());

  return { token, expiresAt: expiresAt.toISOString() };
}
