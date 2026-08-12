"use client";

import { io, Socket } from "socket.io-client";
import { BACKEND_URL, forgetRoomToken, getRoomToken } from "@/lib/backend";

/**
 * One socket per browser tab, shared by every room component (editor,
 * presence, voice, file tree, terminal). The room token is fetched on every
 * (re)connect, so expired tokens are refreshed transparently.
 */

let socket: Socket | null = null;
let currentSlug: string | null = null;
let authRetries = 0;

export const getSocket = (): Socket => {
  if (!socket) {
    socket = io(BACKEND_URL, {
      path: "/api/socket",
      autoConnect: false,
      transports: ["websocket", "polling"],
      auth: (cb) => {
        const slug = currentSlug;
        if (!slug) return cb({});
        getRoomToken(slug)
          .then((token) => cb({ token }))
          .catch(() => cb({}));
      },
    });

    socket.on("connect", () => {
      authRetries = 0;
    });

    // Middleware rejections are not retried by socket.io, so retry with a
    // fresh token a few times (e.g. after the token expired).
    socket.on("connect_error", (err) => {
      if (err.message !== "unauthorized" || !currentSlug || authRetries >= 5) return;
      authRetries++;
      forgetRoomToken(currentSlug);
      setTimeout(() => {
        if (currentSlug && !socket?.connected) socket?.connect();
      }, 1000 * authRetries);
    });
  }
  return socket;
};

export function connectRoomSocket(slug: string): Socket {
  const s = getSocket();
  if (currentSlug !== slug && s.connected) s.disconnect();
  currentSlug = slug;
  if (!s.connected) s.connect();
  return s;
}

export function disconnectRoomSocket() {
  currentSlug = null;
  socket?.disconnect();
}
