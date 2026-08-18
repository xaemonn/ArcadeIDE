import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { errorResponse, HttpError, requireRoom, requireUser } from "@/lib/access";

export async function GET(
  _: Request,
  context: { params: Promise<{ slug: string; id: string }> }
) {
  try {
    const { slug, id } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);

    const commit = await prisma.commit.findFirst({
      where: { id, roomId: room.id },
      include: {
        files: {
          select: {
            id: true,
            name: true,
            language: true,
            content: true,
            oldContent: true,
            fileId: true,
          },
        },
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!commit) throw new HttpError(404, "Commit not found");

    return NextResponse.json(commit);
  } catch (error) {
    return errorResponse(error, "Failed to fetch commit");
  }
}
