import type { Server, Socket } from "socket.io";
import { verifyRoomToken, type RoomUser } from "./auth.js";
import { DocStore } from "./docs.js";
import { addMember, listMembers, removeMember, setMuted } from "./presence.js";

interface SocketData {
  roomId: string;
  user: RoomUser;
}

type RoomSocket = Socket<any, any, any, SocketData>;
type Ack = (response: unknown) => void;

const MAX_TERMINAL_CHARS = 100_000;
const MAX_FILE_NAME = 255;

const isString = (value: unknown, max = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
};

const reply = (ack: unknown, response: unknown) => {
  if (typeof ack === "function") (ack as Ack)(response);
};

const roomChannel = (roomId: string) => `room:${roomId}`;
const voiceChannel = (roomId: string) => `voice:${roomId}`;
const docChannel = (roomId: string, fileId: string) => `doc:${roomId}:${fileId}`;

export function registerRealtime(io: Server) {
  const docs = new DocStore();

  io.use(async (socket, next) => {
    try {
      const claims = await verifyRoomToken(socket.handshake.auth?.token);
      socket.data.roomId = claims.roomId;
      socket.data.user = claims.user;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  const emitPresence = (roomId: string) => {
    io.to(roomChannel(roomId)).emit("presence-update", listMembers(roomId));
  };

  io.on("connection", (rawSocket) => {
    const socket = rawSocket as RoomSocket;
    const { roomId, user } = socket.data;
    const room = roomChannel(roomId);
    const voice = voiceChannel(roomId);

    socket.join(room);
    addMember(roomId, socket.id, user);
    emitPresence(roomId);

    // ---- Collaborative documents (Yjs) ------------------------------------

    socket.on("doc:join", (payload: unknown, ack: unknown) => {
      if (!isRecord(payload) || !isString(payload.fileId)) {
        return reply(ack, { error: "Invalid payload" });
      }
      const content = typeof payload.content === "string" ? payload.content : "";
      const { docId, state } = docs.join(roomId, payload.fileId, socket.id, content);
      socket.join(docChannel(roomId, payload.fileId));
      reply(ack, { docId, state });
    });

    socket.on("doc:update", (payload: unknown) => {
      if (!isRecord(payload) || !isString(payload.fileId)) return;
      const update = toBytes(payload.update);
      if (!update) return;
      if (docs.applyUpdate(roomId, payload.fileId, socket.id, update)) {
        socket
          .to(docChannel(roomId, payload.fileId))
          .emit("doc:update", { fileId: payload.fileId, update });
      }
    });

    socket.on("doc:leave", (payload: unknown) => {
      if (!isRecord(payload) || !isString(payload.fileId)) return;
      docs.leave(roomId, payload.fileId, socket.id);
      socket.leave(docChannel(roomId, payload.fileId));
      socket
        .to(room)
        .emit("cursor-remove", { socketId: socket.id, fileId: payload.fileId });
    });

    // Sent after the database content changed outside the editor (e.g. a
    // commit revert). Everyone else reloads those files from the database;
    // the sender already did.
    socket.on("doc:reset", (payload: unknown) => {
      if (!isRecord(payload) || !Array.isArray(payload.fileIds)) return;
      const fileIds = payload.fileIds.filter((id) => isString(id)).slice(0, 500);
      docs.reset(roomId, fileIds);
      socket.to(room).emit("doc:reset", { fileIds });
    });

    socket.on("cursor-update", (payload: unknown) => {
      if (!isRecord(payload) || !isString(payload.fileId)) return;
      if (!docs.isSubscribed(roomId, payload.fileId, socket.id)) return;
      socket.to(docChannel(roomId, payload.fileId)).emit("cursor-update", {
        socketId: socket.id,
        fileId: payload.fileId,
        user,
        anchor: payload.anchor ?? null,
        head: payload.head ?? null,
      });
    });

    // ---- File tree --------------------------------------------------------

    socket.on("file-add", (payload: unknown) => {
      if (!isRecord(payload) || !isRecord(payload.file)) return;
      const file = payload.file;
      if (!isString(file.id) || !isString(file.name, MAX_FILE_NAME)) return;
      socket.to(room).emit("file-added", {
        id: file.id,
        name: file.name,
        type: file.type === "folder" ? "folder" : "file",
        parentId: typeof file.parentId === "string" ? file.parentId : null,
      });
    });

    socket.on("file-delete", (payload: unknown) => {
      if (!isRecord(payload) || !isString(payload.fileId)) return;
      docs.reset(roomId, [payload.fileId]);
      socket.to(room).emit("file-deleted", payload.fileId);
    });

    socket.on("file-rename", (payload: unknown) => {
      if (!isRecord(payload) || !isString(payload.fileId)) return;
      if (!isString(payload.newName, MAX_FILE_NAME)) return;
      socket
        .to(room)
        .emit("file-renamed", { fileId: payload.fileId, newName: payload.newName });
    });

    // ---- Shared terminal --------------------------------------------------

    socket.on("terminal-output", (payload: unknown) => {
      if (!isRecord(payload)) return;
      const text = (value: unknown) =>
        typeof value === "string" ? value.slice(0, MAX_TERMINAL_CHARS) : "";
      socket.to(room).emit("terminal-update", {
        roomId,
        output: text(payload.output),
        error: text(payload.error),
        exitCode: typeof payload.exitCode === "number" ? payload.exitCode : null,
        ranBy: user.name,
        timeStamp: text(payload.timeStamp).slice(0, 64),
      });
    });

    // ---- Voice chat (WebRTC signaling, full mesh) -------------------------

    const leaveVoice = () => {
      if (!socket.rooms.has(voice)) return;
      socket.leave(voice);
      socket.to(voice).emit("voice:peer-left", { socketId: socket.id });
    };

    socket.on("voice:join", (ack: unknown) => {
      const peers = [...(io.sockets.adapter.rooms.get(voice) ?? [])]
        .filter((id) => id !== socket.id)
        .map((id) => {
          const peer = io.sockets.sockets.get(id) as RoomSocket | undefined;
          return peer ? { socketId: id, user: peer.data.user } : null;
        })
        .filter(Boolean);
      socket.join(voice);
      socket.to(voice).emit("voice:peer-joined", { socketId: socket.id, user });
      reply(ack, { peers });
    });

    socket.on("voice:leave", () => {
      leaveVoice();
      if (setMuted(roomId, socket.id, true)) emitPresence(roomId);
    });

    socket.on("voice:signal", (payload: unknown) => {
      if (!isRecord(payload) || !isString(payload.to)) return;
      const target = io.sockets.sockets.get(payload.to) as RoomSocket | undefined;
      if (!target || target.data.roomId !== roomId) return;
      target.emit("voice:signal", {
        from: socket.id,
        description: payload.description ?? null,
        candidate: payload.candidate ?? null,
      });
    });

    socket.on("mic-status", (payload: unknown) => {
      if (!isRecord(payload)) return;
      if (setMuted(roomId, socket.id, payload.status !== "unmuted")) {
        emitPresence(roomId);
      }
    });

    // ---- Lifecycle --------------------------------------------------------

    // socket.rooms is already empty once "disconnect" fires.
    socket.on("disconnecting", leaveVoice);

    socket.on("disconnect", () => {
      docs.leaveAll(socket.id);
      socket.to(room).emit("cursor-remove", { socketId: socket.id });
      removeMember(roomId, socket.id);
      emitPresence(roomId);
    });
  });

  return { docs };
}
