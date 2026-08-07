import { prisma } from "@/lib/prisma";
import JSZip from "jszip";
import { NextResponse } from "next/server";
import { errorResponse, requireRoom, requireUser } from "@/lib/access";

type ExportFile = {
  id: string;
  name: string;
  type: "file" | "folder";
  content: string;
  parentId: string | null;
};

function bundleFileTree(zip: JSZip, files: ExportFile[], parentId: string | null) {
  for (const file of files.filter((f) => f.parentId === parentId)) {
    if (file.type === "folder") {
      const folder = zip.folder(file.name);
      if (folder) bundleFileTree(folder, files, file.id);
    } else {
      zip.file(file.name, file.content || "");
    }
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
    const files = await prisma.file.findMany({
      where: { roomId: room.id },
      select: { id: true, name: true, type: true, content: true, parentId: true },
    });

    const zip = new JSZip();
    bundleFileTree(zip, files, null);
    const archive = await zip.generateAsync({ type: "uint8array" });

    const asciiName = room.name.replace(/[^\w.-]+/g, "_") || "project";
    return new NextResponse(Buffer.from(archive), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${encodeURIComponent(room.name)}.zip`,
      },
    });
  } catch (error) {
    return errorResponse(error, "Failed to export room");
  }
}
