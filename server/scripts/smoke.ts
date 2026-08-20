/**
 * Checks a running backend end to end: health, every language, and the
 * preview bundler (including an npm import from esm.sh).
 *
 *   ROOM_TOKEN_SECRET=... npm run smoke -- https://your-backend.example.com
 */
import { SignJWT } from "jose";
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth.js";

const baseUrl = (process.argv[2] ?? "http://localhost:4000").replace(/\/$/, "");
const secret = process.env.ROOM_TOKEN_SECRET ?? "arcadeide-dev-secret-change-me";

const token = await new SignJWT({ roomId: "smoke-test", name: "Smoke Test" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject("smoke-test")
  .setIssuer(TOKEN_ISSUER)
  .setAudience(TOKEN_AUDIENCE)
  .setExpirationTime("5m")
  .sign(new TextEncoder().encode(secret));

async function exec(body: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/api/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}

const programs: Array<[string, string, string, string]> = [
  ["javascript", "main.js", "const _ = require('lodash'); console.log(_.sum([40, 2]))", "42"],
  ["typescript", "main.ts", "const n: number = 6 * 7; console.log(n)", "42"],
  ["python", "main.py", "print(sum([40, 2]))", "42"],
  ["c", "main.c", '#include <stdio.h>\nint main(){printf("%d\\n", 40 + 2);return 0;}', "42"],
  ["cpp", "main.cpp", "#include <iostream>\nint main(){std::cout << 40 + 2 << std::endl;}", "42"],
  [
    "java",
    "Main.java",
    "public class Main { public static void main(String[] a){ System.out.println(40 + 2); } }",
    "42",
  ],
];

let failed = false;
const report = (ok: boolean, label: string, detail = "") => {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const health = await fetch(`${baseUrl}/health`).then((r) => r.json());
console.log("health:", JSON.stringify(health));

for (const [language, entry, code, expected] of programs) {
  const result = await exec({ language, entry, files: { [entry]: code } });
  const ok = result.stdout?.trim() === expected;
  report(ok, language, ok ? `${result.durationMs}ms` : JSON.stringify(result).slice(0, 400));
}

const isolation = await exec({
  language: "python",
  entry: "main.py",
  files: { "main.py": "import os\nprint(os.getuid())" },
});
report(isolation.stdout?.trim() !== "0", "user code does not run as root", `uid=${isolation.stdout?.trim()}`);

const preview = await exec({
  mode: "preview",
  entry: "app.js",
  files: { "app.js": "import dayjs from 'dayjs';\nconsole.log(dayjs(0).year());" },
});
report(
  !preview.error && typeof preview.code === "string" && Boolean(preview.packageJson?.dependencies?.dayjs),
  "preview bundles npm imports",
  preview.error ?? JSON.stringify(preview.packageJson)
);

process.exit(failed ? 1 : 0);
