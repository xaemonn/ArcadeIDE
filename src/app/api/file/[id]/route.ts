import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import {
  errorResponse,
  HttpError,
  requireFile,
  requireUser,
  validateFileName,
} from "@/lib/access";

const MAX_CONTENT_CHARS = 2_000_000;

async function deleteRecursive(id: string) {
  const children = await prisma.file.findMany({ where: { parentId: id } });

  for (const child of children) {
    await deleteRecursive(child.id);
  }

  await prisma.file.delete({ where: { id } });
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const user = await requireUser();
    const file = await requireFile(id, user.id);
    return NextResponse.json(file);
  } catch (error) {
    return errorResponse(error, "Failed to load file");
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const user = await requireUser();
    const file = await requireFile(id, user.id);
    const { content, language, name } = await req.json();

    if (content !== undefined) {
      if (typeof content !== "string") throw new HttpError(400, "Invalid content");
      if (content.length > MAX_CONTENT_CHARS) throw new HttpError(413, "File is too large");
    }

    let newName: string | undefined;
    if (name !== undefined) {
      newName = validateFileName(name);
      const clash = await prisma.file.findFirst({
        where: {
          roomId: file.roomId,
          parentId: file.parentId,
          name: newName,
          NOT: { id: file.id },
        },
        select: { id: true },
      });
      if (clash) throw new HttpError(409, `"${newName}" already exists in this folder`);
    }

    const updatedFile = await prisma.file.update({
      where: { id },
      data: {
        ...(content !== undefined ? { content } : {}),
        ...(typeof language === "string" ? { language } : {}),
        ...(newName !== undefined ? { name: newName } : {}),
      },
    });

    return NextResponse.json(updatedFile);
  } catch (error) {
    return errorResponse(error, "Failed to update file");
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const user = await requireUser();
    await requireFile(id, user.id);
    await deleteRecursive(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, "Failed to delete file");
  }
}
