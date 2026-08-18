import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { errorResponse, HttpError, requireRoom, requireUser } from "@/lib/access";

export async function POST(
  req: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);
    const { message, fileIds } = await req.json();

    if (typeof message !== "string" || !message.trim()) {
      throw new HttpError(400, "Commit message is required");
    }
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new HttpError(400, "Select at least one file to commit");
    }

    const files = await prisma.file.findMany({
      where: { roomId: room.id, id: { in: fileIds }, type: "file" },
    });

    // Compare against the last committed version of each file, wherever it was committed.
    const previousVersions = await prisma.commitFile.findMany({
      where: { fileId: { in: files.map((f) => f.id) }, commit: { roomId: room.id } },
      orderBy: { commit: { createdAt: "desc" } },
      distinct: ["fileId"],
    });

    const changedFiles = files.filter((file) => {
      const previous = previousVersions.find((f) => f.fileId === file.id);
      return !previous || previous.content !== file.content;
    });

    if (changedFiles.length === 0) {
      return NextResponse.json({ message: "No changes to commit" }, { status: 200 });
    }

    const commit = await prisma.commit.create({
      data: {
        message: message.trim().slice(0, 500),
        roomId: room.id,
        userId: user.id,
        files: {
          create: changedFiles.map((file) => {
            const previous = previousVersions.find((f) => f.fileId === file.id);
            return {
              name: file.name,
              language: file.language ?? "",
              content: file.content ?? "",
              oldContent: previous?.content ?? "",
              fileId: file.id,
            };
          }),
        },
      },
      include: { files: true },
    });

    return NextResponse.json(commit);
  } catch (error) {
    return errorResponse(error, "Failed to create commit");
  }
}

export async function GET(
  _: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);

    const commits = await prisma.commit.findMany({
      where: { roomId: room.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        message: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    return NextResponse.json(commits);
  } catch (error) {
    return errorResponse(error, "Failed to fetch commits");
  }
}
