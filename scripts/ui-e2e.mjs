/**
 * Browser end-to-end test: two users in two real browser sessions edit the
 * same file, run code, talk over (fake) microphones and open the preview.
 * Uses an installed Chrome or Edge; no browser download needed.
 *
 *   npm run test:ui                    # against http://localhost:3000
 *   BROWSER_CHANNEL=msedge APP_URL=https://... npm run test:ui
 */
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const APP = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const OUT = os.tmpdir();
const run = Date.now().toString(36);
const PASSWORD = "Sup3r$ecret!";
let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  -> ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

async function newUser(name) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, permissions: ["microphone"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  const email = `${name}-${run}@example.com`;
  const signup = await context.request.post(`${APP}/api/auth/signup`, {
    data: { name, email, password: PASSWORD },
  });
  if (signup.status() !== 201) throw new Error(`signup failed ${signup.status()}`);

  await page.goto(`${APP}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.getByRole("button", { name: /login/i }).click();
  await page.waitForURL("**/rooms", { timeout: 15000 });
  return { name, email, context, page, errors };
}

const editorText = (page) =>
  page.evaluate(() => {
    const models = window.monaco?.editor.getModels() ?? [];
    return models.map((m) => m.getValue()).join("\n----\n");
  });

try {
  const alice = await newUser("alice");
  const bob = await newUser("bob");
  check(true, "both users log in through the UI");

  // Room + invite + files through the API (as the logged-in users).
  const room = await (await alice.context.request.post(`${APP}/api/rooms`, { data: { name: "UI Demo" } })).json();
  await alice.context.request.post(`${APP}/api/room/${room.slug}/invite`, { data: { email: bob.email } });
  const invites = await (await bob.context.request.get(`${APP}/api/invite`)).json();
  await bob.context.request.post(`${APP}/api/invite/${invites[0].id}`, { data: { action: "ACCEPT" } });
  const mk = async (data) =>
    (await alice.context.request.post(`${APP}/api/room/${room.slug}/files`, { data })).json();
  await mk({ name: "main.py", content: "print('hello from main')\n" });
  await mk({
    name: "index.html",
    content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 id="out">loading</h1><script src="app.js"></script></body></html>',
  });
  await mk({ name: "style.css", content: "h1 { color: rgb(255, 0, 0); }" });
  await mk({
    name: "app.js",
    content: "import _ from 'lodash';\ndocument.getElementById('out').textContent = _.upperCase('preview works');\nconsole.log('preview log line');\n",
  });

  for (const user of [alice, bob]) {
    await user.page.goto(`${APP}/room/${room.slug}`);
    await user.page.getByText("main.py", { exact: true }).first().click();
    await user.page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });
    await user.page.waitForFunction(
      () => (window.monaco?.editor.getModels() ?? []).some((m) => m.getValue().includes("hello from main")),
      null,
      { timeout: 20000 }
    );
  }
  check(true, "room opens and main.py loads in Monaco for both users");

  await alice.page.waitForSelector('[aria-label="2 users online"]', { timeout: 15000 });
  check(true, "presence shows 2 users online");

  // Wait until both editors are live (no offline badge) before typing together.
  await sleep(1500);
  const offline = await alice.page.locator("text=Offline").count();
  check(offline === 0, "editor is connected to the realtime server");

  // Type at the same time in both browsers.
  await alice.page.click(".monaco-editor .view-lines");
  await bob.page.click(".monaco-editor .view-lines");
  await alice.page.keyboard.press("Control+End");
  await bob.page.keyboard.press("Control+Home");
  await Promise.all([
    alice.page.keyboard.type("print('from alice')", { delay: 15 }),
    bob.page.keyboard.type("# bob was here\n", { delay: 15 }),
  ]);
  await sleep(1500);
  const aText = await editorText(alice.page);
  const bText = await editorText(bob.page);
  check(
    aText === bText && aText.includes("from alice") && aText.includes("# bob was here"),
    "concurrent typing in two browsers converges",
    JSON.stringify({ aText, bText })
  );

  const carets = await bob.page.locator(".arcade-remote-caret").count();
  check(carets > 0, "bob sees alice's remote cursor");

  // Autosave reaches the database.
  await sleep(2500);
  const files = await (await bob.context.request.get(`${APP}/api/room/${room.slug}/files`)).json();
  const saved = files.find((f) => f.name === "main.py")?.content ?? "";
  check(saved.includes("from alice") && saved.includes("# bob was here"), "merged text is autosaved", saved);

  // Undo only affects alice's own edit.
  await alice.page.keyboard.press("Control+z");
  await sleep(800);
  const afterUndo = await editorText(bob.page);
  check(!afterUndo.includes("from alice") && afterUndo.includes("# bob was here"), "undo reverts only your own edits", afterUndo);
  await alice.page.keyboard.press("Control+Shift+z");
  await sleep(800);

  // Create a file in the UI; bob sees it appear.
  await alice.page.getByLabel("Add new file or folder").click();
  await alice.page.getByLabel("New file or folder name").fill("notes.md");
  await alice.page.keyboard.press("Enter");
  await bob.page.getByText("notes.md", { exact: true }).waitFor({ timeout: 10000 });
  check(true, "new file appears for collaborators");

  // Run code; output shows locally and in bob's terminal.
  await alice.page.getByRole("button", { name: "Run", exact: true }).click();
  await alice.page.getByText("from alice").last().waitFor({ timeout: 30000 });
  const aliceTerminal = await alice.page.locator("pre.text-emerald-300").last().innerText();
  check(aliceTerminal.includes("hello from main") && aliceTerminal.includes("from alice"), "Run shows program output", aliceTerminal);
  await bob.page.getByText("Ran by").first().waitFor({ state: "visible", timeout: 10000 });
  check(true, "bob's terminal opens and shows alice's run");

  // Voice chat: fake microphones, audio must actually flow both ways.
  const receivingAudio = (page) =>
    page.waitForFunction(
      () =>
        [...document.querySelectorAll("audio")].some((a) =>
          a.srcObject?.getAudioTracks().some((t) => t.readyState === "live" && !t.muted)
        ),
      null,
      { timeout: 20000 }
    );
  await alice.page.getByTitle("Unmute Mic").click();
  await receivingAudio(bob.page);
  check(true, "bob hears alice (WebRTC audio flowing)");
  await bob.page.getByTitle("Unmute Mic").click();
  await receivingAudio(alice.page);
  check(true, "alice hears bob after he unmutes (renegotiation)");
  await alice.page.locator('[aria-label="2 users online"]').click();
  const unmutedIcons = await alice.page.locator("li svg.text-emerald-500").count();
  check(unmutedIcons === 2, "user list shows both microphones live", String(unmutedIcons));
  await alice.page.locator('[aria-label="2 users online"]').click();
  await alice.page.getByTitle("Mute Mic").click();
  await bob.page.getByTitle("Mute Mic").click();

  // Live preview with an npm import.
  await alice.page.getByText("index.html", { exact: true }).first().click();
  await alice.page.getByRole("button", { name: "Preview", exact: true }).click();
  const frame = alice.page.frameLocator('iframe[title="Live Preview"]');
  await frame.locator("#out").filter({ hasText: "PREVIEW WORKS" }).waitFor({ timeout: 30000 });
  const color = await frame.locator("#out").evaluate((el) => getComputedStyle(el).color);
  check(color === "rgb(255, 0, 0)", "preview renders HTML + CSS + bundled lodash", color);

  await alice.page.screenshot({ path: path.join(OUT, "arcadeide-alice.png") });
  await bob.page.screenshot({ path: path.join(OUT, "arcadeide-bob.png") });
  console.log(`Screenshots saved to ${OUT}`);

  const relevant = (errs) => errs.filter((e) => !/favicon|DevTools|Download the React DevTools/i.test(e));
  check(relevant(alice.errors).length === 0, "no browser errors for alice", relevant(alice.errors).join("\n"));
  check(relevant(bob.errors).length === 0, "no browser errors for bob", relevant(bob.errors).join("\n"));
} catch (error) {
  failures++;
  console.log("FAIL  unexpected error:", error.message);
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? "All UI checks passed." : `${failures} UI check(s) failed.`}`);
process.exit(failures ? 1 : 0);
