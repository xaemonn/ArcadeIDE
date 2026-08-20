import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { SignJWT } from "jose";
import { io as connect, type Socket } from "socket.io-client";
import * as Y from "yjs";

const SECRET = "test-secret";
process.env.ROOM_TOKEN_SECRET = SECRET;
process.env.CLIENT_ORIGIN = "http://localhost:3000";

const { createBackend } = await import("../src/app.js");
const { TOKEN_AUDIENCE, TOKEN_ISSUER } = await import("../src/auth.js");

let baseUrl = "";
let backend: Awaited<ReturnType<typeof createBackend>>;
const sockets: Socket[] = [];

async function token(userId: string, roomId = "room-1", name = userId) {
  return new SignJWT({ roomId, name, picture: null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(SECRET));
}

async function client(userId: string, roomId = "room-1"): Promise<Socket> {
  const socket = connect(baseUrl, {
    path: "/api/socket",
    transports: ["websocket"],
    auth: { token: await token(userId, roomId) },
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

function nextEvent<T = any>(socket: Socket, event: string, predicate?: (value: T) => boolean) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 5000);
    const handler = (value: T) => {
      if (predicate && !predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    socket.on(event, handler);
  });
}

function emitAck<T = any>(socket: Socket, event: string, ...args: unknown[]) {
  return new Promise<T>((resolve) => socket.emit(event, ...args, resolve));
}

async function exec(body: unknown, userId = "runner-user") {
  const response = await fetch(`${baseUrl}/api/exec`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await token(userId)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** Mirrors the browser binding: a local Y.Doc kept in sync over the socket. */
async function openDoc(socket: Socket, fileId: string, content: string) {
  const doc = new Y.Doc();
  const { state } = await emitAck<{ state: ArrayBuffer }>(socket, "doc:join", { fileId, content });
  Y.applyUpdate(doc, new Uint8Array(state), "remote");
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") socket.emit("doc:update", { fileId, update });
  });
  socket.on("doc:update", (payload: { fileId: string; update: ArrayBuffer }) => {
    if (payload.fileId === fileId) Y.applyUpdate(doc, new Uint8Array(payload.update), "remote");
  });
  return doc.getText("content");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

before(async () => {
  backend = await createBackend();
  await new Promise<void>((resolve) => backend.httpServer.listen(0, resolve));
  baseUrl = `http://localhost:${(backend.httpServer.address() as AddressInfo).port}`;
});

after(async () => {
  sockets.forEach((socket) => socket.disconnect());
  await new Promise((resolve) => backend.io.close(resolve));
});

describe("socket auth and presence", () => {
  it("rejects connections without a valid token", async () => {
    const socket = connect(baseUrl, {
      path: "/api/socket",
      transports: ["websocket"],
      auth: { token: "nope" },
      reconnection: false,
    });
    sockets.push(socket);
    const error = await new Promise<Error>((resolve) => socket.once("connect_error", resolve));
    assert.equal(error.message, "unauthorized");
  });

  it("broadcasts deduplicated presence and mic status", async () => {
    const alice = await client("alice", "presence-room");
    const twoUsers = nextEvent<any[]>(alice, "presence-update", (users) => users.length === 2);
    await client("bob", "presence-room");
    await client("bob", "presence-room"); // second tab, same user
    const users = await twoUsers;
    assert.deepEqual(users.map((u) => u.id).sort(), ["alice", "bob"]);

    const unmuted = nextEvent<any[]>(alice, "presence-update", (list) =>
      list.some((u) => u.id === "alice" && !u.muted)
    );
    alice.emit("mic-status", { status: "unmuted" });
    await unmuted;
  });

  it("keeps rooms isolated", async () => {
    const outsider = await client("mallory", "other-room");
    const insider = await client("carol", "isolated-room");
    let leaked = false;
    outsider.on("file-added", () => (leaked = true));
    insider.emit("file-add", { file: { id: "f1", name: "a.js", type: "file" } });
    await settle();
    assert.equal(leaked, false);
  });
});

describe("collaborative documents", () => {
  it("returns a stable document id until the document is recreated", async () => {
    const a = await client("id-a", "id-room");
    const first = await emitAck<{ docId: string }>(a, "doc:join", { fileId: "f", content: "x" });
    const again = await emitAck<{ docId: string }>(a, "doc:join", { fileId: "f", content: "y" });
    assert.equal(first.docId, again.docId);
    a.emit("doc:reset", { fileIds: ["f"] });
    const fresh = await emitAck<{ docId: string }>(a, "doc:join", { fileId: "f", content: "z" });
    assert.notEqual(fresh.docId, first.docId);
  });

  it("seeds from the first client and merges concurrent edits", async () => {
    const a = await client("doc-a", "doc-room");
    const b = await client("doc-b", "doc-room");
    const textA = await openDoc(a, "file-1", "hello");
    const textB = await openDoc(b, "file-1", "stale database content");
    assert.equal(textB.toString(), "hello");

    // Both type at the same moment, before seeing each other's change.
    textA.insert(0, "A:");
    textB.insert(textB.length, "!");
    await settle();

    assert.equal(textA.toString(), "A:hello!");
    assert.equal(textB.toString(), "A:hello!");
    assert.equal(backend.docs.getText("doc-room", "file-1"), "A:hello!");
  });

  it("reseeds a document after doc:reset", async () => {
    const a = await client("reset-a", "reset-room");
    const b = await client("reset-b", "reset-room");
    await openDoc(a, "file-2", "old");
    const resetSeen = nextEvent(b, "doc:reset");
    a.emit("doc:reset", { fileIds: ["file-2"] });
    assert.deepEqual((await resetSeen).fileIds, ["file-2"]);
    const fresh = await openDoc(a, "file-2", "reverted");
    assert.equal(fresh.toString(), "reverted");
  });

  it("forwards remote cursors only to subscribers of the same file", async () => {
    const a = await client("cursor-a", "cursor-room");
    const b = await client("cursor-b", "cursor-room");
    await openDoc(a, "file-3", "x");
    await openDoc(b, "file-3", "x");
    const cursor = nextEvent<any>(b, "cursor-update");
    a.emit("cursor-update", { fileId: "file-3", anchor: { a: 1 }, head: { h: 1 } });
    const received = await cursor;
    assert.equal(received.user.id, "cursor-a");
    assert.equal(received.socketId, a.id);
  });
});

describe("voice signaling", () => {
  it("announces peers and relays signals inside the room", async () => {
    const a = await client("voice-a", "voice-room");
    const b = await client("voice-b", "voice-room");
    const first = await emitAck<{ peers: any[] }>(a, "voice:join");
    assert.equal(first.peers.length, 0);

    const joined = nextEvent<any>(a, "voice:peer-joined");
    const second = await emitAck<{ peers: any[] }>(b, "voice:join");
    assert.equal(second.peers[0].socketId, a.id);
    assert.equal((await joined).socketId, b.id);

    const signal = nextEvent<any>(a, "voice:signal");
    b.emit("voice:signal", { to: a.id, description: { type: "offer", sdp: "x" } });
    const received = await signal;
    assert.equal(received.from, b.id);
    assert.equal(received.description.type, "offer");

    const left = nextEvent<any>(a, "voice:peer-left");
    const bId = b.id;
    b.disconnect();
    assert.equal((await left).socketId, bId);
  });
});

describe("code execution", () => {
  it("requires a room token", async () => {
    const response = await fetch(`${baseUrl}/api/exec`, { method: "POST" });
    assert.equal(response.status, 401);
  });

  it("runs multi-file JavaScript with stdin", async () => {
    const { body } = await exec({
      language: "javascript",
      entry: "main.js",
      stdin: "Ada",
      files: {
        "main.js": `const { greet } = require("./lib/greet");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => console.log(greet(input.trim())));`,
        "lib/greet.js": "exports.greet = (name) => `Hello, ${name}!`;",
      },
    });
    assert.equal(body.stdout.trim(), "Hello, Ada!");
    assert.equal(body.exitCode, 0);
  });

  it("compiles and runs TypeScript", async () => {
    const { body } = await exec({
      language: "typescript",
      entry: "src/main.ts",
      files: {
        "src/main.ts": `import { add } from "./math";\nconst n: number = add(2, 3);\nconsole.log(n);`,
        "src/math.ts": "export const add = (a: number, b: number): number => a + b;",
      },
    });
    assert.equal(body.stdout.trim(), "5");
  });

  it("reports runtime errors on stderr with a non-zero exit code", async () => {
    const { body } = await exec({
      language: "javascript",
      entry: "main.js",
      files: { "main.js": "throw new Error('boom')" },
    });
    assert.notEqual(body.exitCode, 0);
    assert.match(body.stderr, /boom/);
  });

  it("kills programs that run too long", { timeout: 20_000 }, async () => {
    const { body } = await exec({
      language: "javascript",
      entry: "main.js",
      files: { "main.js": "while (true) {}" },
    });
    assert.equal(body.timedOut, true);
    assert.match(body.stderr, /Time limit exceeded/);
  });

  it("blocks process spawning and networking", async () => {
    const { body } = await exec({
      language: "javascript",
      entry: "main.js",
      files: { "main.js": "require('node:child_process').execSync('ls')" },
    });
    assert.equal(body.blocked, true);
    assert.match(body.stderr, /child_process/);
  });

  it("rejects paths that escape the project", async () => {
    const { status } = await exec({
      language: "javascript",
      entry: "../main.js",
      files: { "../main.js": "console.log(1)" },
    });
    assert.equal(status, 400);
  });

  it("runs Python when it is installed", async (t) => {
    if (!backend.languages.python) return t.skip("python not installed");
    const { body } = await exec({
      language: "python",
      entry: "main.py",
      stdin: "4\n",
      files: {
        "main.py": "from helpers import square\nprint(square(int(input())))",
        "helpers.py": "def square(n):\n    return n * n",
      },
    });
    assert.equal(body.stdout.trim(), "16");
  });

  it("bundles preview scripts with relative imports and CSS", async () => {
    const { body } = await exec({
      mode: "preview",
      entry: "js/app.js",
      files: {
        "js/app.js": "import { msg } from './msg';\nimport '../styles/extra.css';\ndocument.body.append(msg);",
        "js/msg.js": "export const msg = 'hi from module';",
        "styles/extra.css": "body { color: red; }",
      },
    });
    assert.equal(body.error, undefined);
    assert.match(body.code, /hi from module/);
    assert.match(body.code, /color: red/);
    assert.equal(body.packageJson, undefined);
  });

  it("reports missing preview imports as errors", async () => {
    const { body } = await exec({
      mode: "preview",
      entry: "app.js",
      files: { "app.js": "import './missing';" },
    });
    assert.match(body.error, /Cannot find "\.\/missing"/);
  });
});
