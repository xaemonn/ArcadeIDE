import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import { createRoomSlug } from "@/lib/slug";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: teamId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await req.json();
  if (!name) {
    return NextResponse.json(
      { error: "Room name is required" },
      { status: 400 }
    );
  }

  // Check if team exists and the user belongs to it
  const team = await prisma.team.findFirst({
    where: { id: teamId, members: { some: { email: session.user.email } } },
  });
  if (!team) {
    return NextResponse.json({ error: "Team not found" }, { status: 404 });
  }

  // Check duplicate room
  const existingRoom = await prisma.room.findUnique({
    where: {
      name_teamId: { name, teamId },
    },
  });

  if (existingRoom) {
    return NextResponse.json(
      { error: "Room with this name already exists in this team" },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });

  const newRoom = await prisma.room.create({
    data: {
      name,
      slug: createRoomSlug(name),
      teamId,
      ownerId: user!.id,
    },
  });

  return NextResponse.json(newRoom);
}
