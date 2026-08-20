/**
 * End-to-end check of a running stack (Next.js app + backend + database),
 * acting as two users through the real HTTP and Socket.IO APIs.
 *
 *   node scripts/e2e.mjs [appUrl] [backendUrl]
 *
 * Creates two throwaway accounts and a room, so point it at a local or
 * staging deployment rather than production.
 */
import { io } from "socket.io-client";
import * as Y from "yjs";

const APP = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const BACKEND = (process.argv[3] ?? "http://localhost:4000").replace(/\/$/, "");
const run = Date.now().toString(36);
const PASSWORD = "Sup3r$ecret!";

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `  -> ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.email = `${name}-${run}@example.com`;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  store(res) {
    for (const cookie of res.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  async request(path, { method = "GET", json, form } = {}) {
    const headers = { cookie: this.cookieHeader() };
    let body;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(`${APP}${path}`, { method, headers, body, redirect: "manual" });
    this.store(res);
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, type };
  }
  async signupAndLogin() {
    const signup = await this.request("/api/auth/signup", {
      method: "POST",
      json: { name: this.name, email: this.email, password: PASSWORD },
    });
    check(signup.status === 201 && !("password" in (signup.data.user ?? {})), `${this.name}: sign up (no password hash in response)`, JSON.stringify(signup.data));

    const { data: csrf } = await this.request("/api/auth/csrf");
    const login = await this.request("/api/auth/callback/credentials", {
      method: "POST",
      form: { csrfToken: csrf.csrfToken, email: this.email, password: PASSWORD, json: "true" },
    });
    const session = await this.request("/api/auth/session");
    this.id = session.data?.user?.id;
    check(Boolean(this.id), `${this.name}: log in with email/password`, `status ${login.status}`);
  }
  async token(slug) {
    const res = await this.request(`/api/room/${slug}/token`);
    return res;
  }
}

async function connect(token) {
  const socket = io(BACKEND, { path: "/api/socket", auth: { token }, transports: ["websocket"], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

async function openDoc(socket, fileId, content) {
  const doc = new Y.Doc();
  const res = await socket.emitWithAck("doc:join", { fileId, content });
  Y.applyUpdate(doc, new Uint8Array(res.state), "remote");
  doc.on("update", (update, origin) => {
    if (origin !== "remote") socket.emit("doc:update", { fileId, update });
  });
  socket.on("doc:update", (p) => {
    if (p.fileId === fileId) Y.applyUpdate(doc, new Uint8Array(p.update), "remote");
  });
  return doc.getText("content");
}

async function exec(token, body) {
  const res = await fetch(`${BACKEND}/api/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin: APP },
    body: JSON.stringify(body),
  });
  return { status: res.status, cors: res.headers.get("access-control-allow-origin"), data: await res.json() };
}

// ---------------------------------------------------------------------------

console.log(`App: ${APP}\nBackend: ${BACKEND}\n`);
const health = await fetch(`${BACKEND}/health`).then((r) => r.json());
check(health.status === "ok", "backend health", JSON.stringify(health));

const alice = new Client("alice");
const bob = new Client("bob");
await alice.signupAndLogin();
await bob.signupAndLogin();

// Access control
const anonymous = new Client("anon");
check((await anonymous.request("/api/rooms")).status === 401, "anonymous users cannot list rooms");
check((await anonymous.request("/api/test-db")).status === 404, "debug endpoint /api/test-db is gone");

const created = await alice.request("/api/rooms", { method: "POST", json: { name: "Demo Room / #1" } });
const slug = created.data.slug;
check(created.status === 200 && /^demo-room-1-[a-f0-9]{6}$/.test(slug), "room gets a unique URL-safe slug", slug);

check((await bob.request(`/api/room/${slug}`)).status === 403, "non-members get 403 for the room");
check((await bob.token(slug)).status === 403, "non-members cannot get a realtime token");

// Invite flow
const invite = await alice.request(`/api/room/${slug}/invite`, { method: "POST", json: { email: bob.email } });
check(invite.status === 200, "owner invites bob", JSON.stringify(invite.data));
const pending = await bob.request("/api/invite");
const inviteId = pending.data.find((i) => i.room.slug === slug)?.id;
await bob.request(`/api/invite/${inviteId}`, { method: "POST", json: { action: "ACCEPT" } });
check((await bob.request(`/api/room/${slug}`)).status === 200, "bob can open the room after accepting");

// Files
const mk = (json) => alice.request(`/api/room/${slug}/files`, { method: "POST", json });
const lib = (await mk({ name: "lib", type: "folder" })).data;
const helpers = (await mk({ name: "helpers.py", parentId: lib.id, content: "def greet(name):\n    return f'Hello, {name}!'\n" })).data;
const main = (await mk({ name: "main.py", content: "from lib.helpers import greet\nprint(greet(input()))\n" })).data;
const html = (await mk({ name: "index.html", content: '<html><head><link rel="stylesheet" href="style.css"></head><body><div id="out"></div><script src="app.js"></script></body></html>' })).data;
await mk({ name: "style.css", content: "body { color: red; }" });
const appJs = (await mk({ name: "app.js", content: "import _ from 'lodash';\ndocument.getElementById('out').textContent = _.capitalize('preview works');\n" })).data;
check(Boolean(main.id && helpers.id && html.id && appJs.id), "create files and folders");
const dup = await mk({ name: "main.py" });
check(dup.status === 409, "duplicate file names are rejected");
check((await anonymous.request(`/api/file/${main.id}`)).status === 401, "files require login");

// Realtime: presence + collaborative editing
const aliceToken = (await alice.token(slug)).data;
const bobToken = (await bob.token(slug)).data;
check(Boolean(aliceToken.token && bobToken.token), "members receive room tokens");
const sa = await connect(aliceToken.token);
const presence = new Promise((resolve) => sa.on("presence-update", (users) => users.length === 2 && resolve(users)));
const sb = await connect(bobToken.token);
const users = await Promise.race([presence, sleep(3000).then(() => [])]);
check(users.length === 2, "presence shows both users", JSON.stringify(users));

const original = main.content;
const ta = await openDoc(sa, main.id, original);
const tb = await openDoc(sb, main.id, "stale");
check(tb.toString() === original, "second editor receives the live document");
ta.insert(0, "# edited by alice\n");
tb.insert(tb.length, "# edited by bob\n");
await sleep(300);
check(ta.toString() === tb.toString() && ta.toString().includes("alice") && ta.toString().includes("bob"), "simultaneous edits merge without loss");

const merged = ta.toString();
await alice.request(`/api/file/${main.id}`, { method: "PATCH", json: { content: merged } });
check((await bob.request(`/api/file/${main.id}`)).data.content === merged, "saved content is visible to collaborators");

// Shared terminal
const terminal = new Promise((resolve) => sb.once("terminal-update", resolve));
sa.emit("terminal-output", { output: "hi", error: "", exitCode: 0, timeStamp: "now" });
const termEvent = await Promise.race([terminal, sleep(2000).then(() => null)]);
check(termEvent?.ranBy === "alice", "terminal output is shared with the room");

// Code execution (multi-file Python with stdin)
const files = {
  "main.py": merged,
  "lib/helpers.py": helpers.content,
  "lib/__init__.py": "",
};
const runResult = await exec(aliceToken.token, { language: "python", mode: "execute", entry: "main.py", files, stdin: "Ada\n" });
check(runResult.data.stdout?.trim() === "Hello, Ada!", "run multi-file Python with stdin", JSON.stringify(runResult.data));
check(runResult.cors === APP, "backend CORS allows the app origin", String(runResult.cors));

// Preview bundling with an npm package
const preview = await exec(aliceToken.token, {
  mode: "preview",
  entry: "app.js",
  files: { "app.js": appJs.content },
});
check(!preview.data.error && preview.data.code?.includes("capitalize") && preview.data.packageJson?.dependencies?.lodash, "preview bundles npm imports", preview.data.error);

// Version control
const commit = await alice.request(`/api/room/${slug}/commit`, { method: "POST", json: { message: "first", fileIds: [main.id] } });
check(Boolean(commit.data.id), "commit selected files");
await alice.request(`/api/file/${main.id}`, { method: "PATCH", json: { content: "broken" } });
const status = await alice.request(`/api/room/${slug}/status`);
check(status.data.find((f) => f.id === main.id)?.status === "modified", "status detects modified files");
const revert = await alice.request(`/api/room/${slug}/commit/${commit.data.id}/revert`, { method: "POST" });
check(revert.data.fileIds?.includes(main.id), "revert reports affected files");
check((await alice.request(`/api/file/${main.id}`)).data.content === merged, "revert restores committed content");

const resetSeen = new Promise((resolve) => sb.once("doc:reset", resolve));
sa.emit("doc:reset", { fileIds: revert.data.fileIds });
check(Boolean(await Promise.race([resetSeen, sleep(2000).then(() => null)])), "collaborators are told to reload reverted files");

// Export, AI
const zip = await alice.request(`/api/room/${slug}/export`);
check(zip.status === 200 && zip.type.includes("zip"), "export room as ZIP");
const ai = await alice.request("/api/ai/explain", { method: "POST", json: { code: "x = 1", language: "python" } });
check(ai.status === 200 || ai.status === 503, "AI route responds (503 when no key is configured)", `${ai.status}`);
check((await anonymous.request("/api/ai/explain", { method: "POST", json: { code: "x" } })).status === 401, "AI routes require login");

// Deleting the room removes access
await alice.request(`/api/room/${slug}`, { method: "DELETE" });
check((await alice.request(`/api/room/${slug}`)).status === 404, "owner can delete the room");

sa.disconnect();
sb.disconnect();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
process.exit(failures ? 1 : 0);
