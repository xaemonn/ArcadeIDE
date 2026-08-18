import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { errorResponse, requireRoom, requireUser } from "@/lib/access";

/** Per-file status against each file's last committed version. */
export async function GET(_: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);

    const [files, committed] = await Promise.all([
      prisma.file.findMany({
        where: { roomId: room.id, type: "file" },
        select: { id: true, name: true, content: true },
        orderBy: { name: "asc" },
      }),
      prisma.commitFile.findMany({
        where: { commit: { roomId: room.id } },
        orderBy: { commit: { createdAt: "desc" } },
        distinct: ["fileId"],
        select: { fileId: true, content: true },
      }),
    ]);

    const lastCommitted = new Map(committed.map((f) => [f.fileId, f.content]));

    return NextResponse.json(
      files.map((file) => {
        const previous = lastCommitted.get(file.id);
        const status =
          previous === undefined
            ? "new"
            : previous.trim() === file.content.trim()
              ? "unchanged"
              : "modified";
        return { id: file.id, name: file.name, status };
      })
    );
  } catch (error) {
    return errorResponse(error, "Failed to load file status");
  }
}
