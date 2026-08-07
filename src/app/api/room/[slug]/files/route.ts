import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  errorResponse,
  HttpError,
  requireRoom,
  requireUser,
  validateFileName,
} from "@/lib/access";
import { editorLanguage } from "@/lib/languages";

export async function GET(_: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);
    const files = await prisma.file.findMany({
      where: { roomId: room.id },
      orderBy: [{ type: "desc" }, { name: "asc" }],
    });
    return NextResponse.json(files);
  } catch (error) {
    return errorResponse(error, "Failed to fetch files");
  }
}

export async function POST(req: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);
    const { name: rawName, parentId = null, content = "", type } = await req.json();

    const name = validateFileName(rawName);
    if (typeof content !== "string") throw new HttpError(400, "Invalid content");

    if (parentId !== null) {
      const parent = await prisma.file.findFirst({
        where: { id: parentId, roomId: room.id, type: "folder" },
        select: { id: true },
      });
      if (!parent) throw new HttpError(400, "Parent folder not found");
    }

    const clash = await prisma.file.findFirst({
      where: { roomId: room.id, parentId, name },
      select: { id: true },
    });
    if (clash) throw new HttpError(409, `"${name}" already exists in this folder`);

    const isFolder = type === "folder" || (type !== "file" && !name.includes("."));
    const newFile = await prisma.file.create({
      data: {
        name,
        type: isFolder ? "folder" : "file",
        language: isFolder ? null : editorLanguage(name),
        parentId,
        roomId: room.id,
        content: isFolder ? "" : content,
      },
    });

    return NextResponse.json(newFile);
  } catch (error) {
    return errorResponse(error, "Failed to create file");
  }
}
