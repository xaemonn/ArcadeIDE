import http from "node:http";
import { Server } from "socket.io";
import { assertConfig, isAllowedOrigin } from "./config.js";
import { detectToolchain } from "./exec/languages.js";
import { detectSandbox } from "./exec/sandbox.js";
import { createHttpApp } from "./http.js";
import { registerRealtime } from "./realtime.js";

export async function createBackend() {
  assertConfig();
  const [sandbox, languages] = await Promise.all([detectSandbox(), detectToolchain()]);

  const httpServer = http.createServer(createHttpApp());
  const io = new Server(httpServer, {
    path: "/api/socket",
    cors: {
      origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    },
    maxHttpBufferSize: 5e6,
    pingInterval: 20_000,
    pingTimeout: 20_000,
  });
  const realtime = registerRealtime(io);

  return { httpServer, io, sandbox, languages, docs: realtime.docs };
}
