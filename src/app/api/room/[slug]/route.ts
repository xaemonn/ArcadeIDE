import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { errorResponse, HttpError, requireRoom, requireUser } from "@/lib/access";

export async function GET(
  _: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);
    return NextResponse.json({
      id: room.id,
      name: room.name,
      slug: room.slug,
      teamId: room.teamId,
      isOwner: room.ownerId === user.id,
    });
  } catch (error) {
    return errorResponse(error, "Failed to fetch room");
  }
}

// Leave a room you were invited to.
export async function POST(
  _: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();

    const room = await prisma.room.findUnique({
      where: { slug },
      select: {
        id: true,
        ownerId: true,
        members: { where: { id: user.id }, select: { id: true } },
      },
    });

    if (!room) throw new HttpError(404, "Room not found");
    if (room.ownerId === user.id) {
      throw new HttpError(400, "Owner cannot leave the room. Delete it instead.");
    }
    if (room.members.length === 0) {
      throw new HttpError(400, "You are not a member of this room.");
    }

    await prisma.room.update({
      where: { id: room.id },
      data: { members: { disconnect: { id: user.id } } },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, "Failed to leave room");
  }
}

export async function DELETE(
  _: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();

    const room = await prisma.room.findUnique({
      where: { slug },
      select: { ownerId: true, team: { select: { createdById: true } } },
    });
    if (!room) throw new HttpError(404, "Room not found");

    const canDelete =
      room.ownerId === user.id || room.team?.createdById === user.id;
    if (!canDelete) throw new HttpError(403, "Forbidden");

    await prisma.room.delete({ where: { slug } });

    return NextResponse.json({ message: "Room deleted successfully" });
  } catch (error) {
    return errorResponse(error, "Failed to delete room");
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);
    const { name } = await req.json();

    if (typeof name !== "string" || !name.trim() || name.length > 100) {
      throw new HttpError(400, "Invalid room name");
    }
    if (room.ownerId !== user.id) throw new HttpError(403, "Only the owner can rename the room");

    const updatedRoom = await prisma.room.update({
      where: { id: room.id },
      data: { name: name.trim() },
      select: { id: true, name: true, slug: true },
    });

    return NextResponse.json(updatedRoom);
  } catch (error) {
    return errorResponse(error, "Failed to update room");
  }
}
