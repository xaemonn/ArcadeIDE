import "./env.js";
import { createBackend } from "./app.js";
import { config } from "./config.js";

const { httpServer, io, sandbox, languages } = await createBackend();

httpServer.listen(config.port, () => {
  const enabled = Object.entries(languages)
    .filter(([, ok]) => ok)
    .map(([name]) => name)
    .join(", ");
  console.log(`[arcadeide-server] listening on :${config.port}`);
  console.log(`[arcadeide-server] allowed origins: ${config.clientOrigins.join(", ")}`);
  console.log(
    `[arcadeide-server] sandbox: ${sandbox.mode}` +
      (sandbox.reason ? ` (${sandbox.reason})` : "") +
      `, network for user code: ${sandbox.network}, rlimits: ${sandbox.prlimit}`
  );
  console.log(`[arcadeide-server] languages: ${enabled}`);
});

const shutdown = (signal: string) => {
  console.log(`[arcadeide-server] ${signal} received, shutting down`);
  // Closes the Socket.IO server and the underlying HTTP server.
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
