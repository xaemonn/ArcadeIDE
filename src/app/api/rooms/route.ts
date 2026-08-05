import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createRoomSlug } from "@/lib/slug";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      include: {
        ownedRooms: true,
        rooms: {
          where: {
            NOT: {
              ownerId: session.user.id,
            },
          },
        },
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const ownedRooms = user.ownedRooms.map((room) => ({
      ...room,
      owned: true,
    }));
    const joinedRooms = user.rooms.map((room) => ({ ...room, owned: false }));

    const uniqueRooms = [...ownedRooms, ...joinedRooms].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return NextResponse.json(uniqueRooms);
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to fetch rooms" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const { name: rawName } = await req.json();
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name || name.length > 100) {
      return NextResponse.json(
        { error: "A room name (max 100 characters) is required" },
        { status: 400 }
      );
    }

    const session = await getServerSession(authOptions);
    if (!session || !session.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const newRoom = await prisma.room.create({
      data: {
        name,
        slug: createRoomSlug(name),
        ownerId: user.id,
      },
    });

    return NextResponse.json(newRoom);
  } catch (error) {
    return NextResponse.json(
      { error: "Room creation failed" },
      { status: 500 }
    );
  }
}
