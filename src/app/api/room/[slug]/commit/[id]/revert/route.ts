import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { errorResponse, HttpError, requireRoom, requireUser } from "@/lib/access";

export async function POST(
  _: Request,
  context: { params: Promise<{ slug: string; id: string }> }
) {
  try {
    const { slug, id } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);

    const targetCommit = await prisma.commit.findFirst({
      where: { id, roomId: room.id },
      include: { files: true },
    });
    if (!targetCommit) throw new HttpError(404, "Commit not found");

    const existingFiles = await prisma.file.findMany({
      where: { roomId: room.id, id: { in: targetCommit.files.map((f) => f.fileId) } },
      select: { id: true, content: true },
    });
    const existing = new Map(existingFiles.map((f) => [f.id, f]));
    const restorable = targetCommit.files.filter((f) => existing.has(f.fileId));

    await prisma.$transaction([
      ...restorable.map((file) =>
        prisma.file.update({
          where: { id: file.fileId },
          data: { name: file.name, language: file.language, content: file.content },
        })
      ),
      prisma.commit.create({
        data: {
          roomId: room.id,
          userId: user.id,
          message: `Reverted to: ${targetCommit.message}`,
          files: {
            create: restorable.map((f) => ({
              fileId: f.fileId,
              name: f.name,
              content: f.content,
              language: f.language,
              oldContent: existing.get(f.fileId)?.content ?? "",
            })),
          },
        },
      }),
    ]);

    // The client tells collaborators to reload these files.
    return NextResponse.json({
      success: true,
      fileIds: restorable.map((f) => f.fileId),
      renamed: restorable.map((f) => ({ id: f.fileId, name: f.name })),
    });
  } catch (error) {
    return errorResponse(error, "Failed to revert");
  }
}
