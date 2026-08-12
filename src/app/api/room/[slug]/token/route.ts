import { NextResponse } from "next/server";
import { errorResponse, requireRoom, requireUser } from "@/lib/access";
import { signRoomToken } from "@/lib/roomToken";

export async function GET(
  _: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;
    const user = await requireUser();
    const room = await requireRoom(slug, user.id);

    const { token, expiresAt } = await signRoomToken({
      userId: user.id,
      name: user.name || "Anonymous",
      image: user.image ?? null,
      roomId: room.id,
    });

    return NextResponse.json(
      { token, expiresAt, roomId: room.id },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return errorResponse(error, "Failed to authorize room access");
  }
}
