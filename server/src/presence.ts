import type { RoomUser } from "./auth.js";

interface Member {
  user: RoomUser;
  muted: boolean;
}

export interface PresenceUser extends RoomUser {
  muted: boolean;
}

// roomId -> socketId -> member. A user can have several sockets (tabs).
const rooms = new Map<string, Map<string, Member>>();

export function addMember(roomId: string, socketId: string, user: RoomUser) {
  let members = rooms.get(roomId);
  if (!members) {
    members = new Map();
    rooms.set(roomId, members);
  }
  members.set(socketId, { user, muted: true });
}

export function removeMember(roomId: string, socketId: string) {
  const members = rooms.get(roomId);
  if (!members) return;
  members.delete(socketId);
  if (members.size === 0) rooms.delete(roomId);
}

export function setMuted(roomId: string, socketId: string, muted: boolean) {
  const member = rooms.get(roomId)?.get(socketId);
  if (!member || member.muted === muted) return false;
  member.muted = muted;
  return true;
}

export function listMembers(roomId: string): PresenceUser[] {
  const byUser = new Map<string, PresenceUser>();
  for (const { user, muted } of rooms.get(roomId)?.values() ?? []) {
    const existing = byUser.get(user.id);
    if (existing) {
      // Unmuted in any tab counts as unmuted.
      existing.muted = existing.muted && muted;
    } else {
      byUser.set(user.id, { ...user, muted });
    }
  }
  return [...byUser.values()];
}
