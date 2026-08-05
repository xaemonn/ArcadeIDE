import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function requireUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new HttpError(401, "Unauthorized");
  return session.user;
}

/** A user can open a room they own, were invited to, or whose team they are in. */
export function roomAccessWhere(userId: string): Prisma.RoomWhereInput {
  return {
    OR: [
      { ownerId: userId },
      { members: { some: { id: userId } } },
      { team: { members: { some: { id: userId } } } },
    ],
  };
}

export async function requireRoom(slug: string, userId: string) {
  const room = await prisma.room.findFirst({
    where: { slug, ...roomAccessWhere(userId) },
  });
  if (room) return room;

  const exists = await prisma.room.findUnique({
    where: { slug },
    select: { id: true },
  });
  throw exists
    ? new HttpError(403, "You do not have access to this room")
    : new HttpError(404, "Room not found");
}

export async function requireFile(fileId: string, userId: string) {
  const file = await prisma.file.findFirst({
    where: { id: fileId, room: roomAccessWhere(userId) },
  });
  if (!file) throw new HttpError(404, "File not found");
  return file;
}

export function errorResponse(error: unknown, fallback = "Something went wrong") {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

const INVALID_NAME = /[\/\\\0]|^\.{1,2}$/;

export function validateFileName(name: unknown): string {
  if (typeof name !== "string") throw new HttpError(400, "Name is required");
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 255 || INVALID_NAME.test(trimmed)) {
    throw new HttpError(400, "Invalid file or folder name");
  }
  return trimmed;
}
