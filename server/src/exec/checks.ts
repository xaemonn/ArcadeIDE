import type { Language } from "./languages.js";

/**
 * Cheap static policy checks that run before user code.
 *
 * They block the obvious ways to spawn processes or open network
 * connections. They are easy to bypass on purpose, so the real boundary is
 * the sandbox (unprivileged uid, rlimits, timeouts). Treat these as a guard
 * against casual abuse, not as isolation.
 */

const JS_BLOCKED_MODULES = [
  "child_process",
  "cluster",
  "worker_threads",
  "net",
  "dgram",
  "dns",
  "http",
  "https",
  "http2",
  "tls",
  "inspector",
  "vm",
  "v8",
  "repl",
];

const PY_BLOCKED_MODULES = [
  "subprocess",
  "socket",
  "ctypes",
  "multiprocessing",
  "pty",
  "urllib",
  "http",
  "requests",
  "ftplib",
  "smtplib",
  "telnetlib",
  "socketserver",
];

function checkJavaScript(code: string): string[] {
  const issues: string[] = [];
  for (const mod of JS_BLOCKED_MODULES) {
    const pattern = new RegExp(
      String.raw`(require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)['"\`](node:)?${mod}(/[^'"\`]*)?['"\`]`
    );
    if (pattern.test(code)) issues.push(`Module "${mod}" is not allowed`);
  }
  if (/process\s*\.\s*(binding|_linkedBinding|dlopen|kill)\b/.test(code)) {
    issues.push("Low level process APIs are not allowed");
  }
  return issues;
}

function checkPython(code: string): string[] {
  const issues: string[] = [];
  for (const mod of PY_BLOCKED_MODULES) {
    const pattern = new RegExp(
      String.raw`^[ \t]*(import[ \t]+[\w \t,.]*\b${mod}\b|from[ \t]+${mod}(\.\w+)*[ \t]+import)`,
      "m"
    );
    if (pattern.test(code)) issues.push(`Module "${mod}" is not allowed`);
  }
  const osCall = code.match(
    /\bos\s*\.\s*(system|popen|exec\w*|spawn\w*|fork\w*|kill\w*|setuid|setgid)\s*\(/
  );
  if (osCall) issues.push(`"${osCall[0].replace(/\s+/g, "")}" is not allowed`);
  if (/\b__import__\s*\(/.test(code)) issues.push('"__import__" is not allowed');
  return issues;
}

function checkC(code: string): string[] {
  const issues: string[] = [];
  const header = code.match(
    /#\s*include\s*<\s*(sys\/socket|netinet\/[\w.]+|arpa\/inet|netdb|sys\/ptrace|dlfcn)(\.h)?\s*>/
  );
  if (header) issues.push(`Header <${header[1]}> is not allowed`);
  const call = code.match(
    /\b(system|popen|fork|vfork|execl|execlp|execle|execv|execvp|execve|socket|ptrace|dlopen)\s*\(/
  );
  if (call) issues.push(`"${call[1]}()" is not allowed`);
  if (/\b(asm|__asm__)\b/.test(code)) issues.push("Inline assembly is not allowed");
  return issues;
}

function checkJava(code: string): string[] {
  const issues: string[] = [];
  if (/\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\b/.test(code)) {
    issues.push('"Runtime.exec" is not allowed');
  }
  if (/\bProcessBuilder\b/.test(code)) issues.push('"ProcessBuilder" is not allowed');
  if (/\bjava\s*\.\s*net\b/.test(code)) issues.push('"java.net" is not allowed');
  if (/\bSystem\s*\.\s*(load|loadLibrary)\s*\(/.test(code)) {
    issues.push("Loading native libraries is not allowed");
  }
  return issues;
}

const SOURCE_EXTENSIONS: Record<Language, RegExp> = {
  javascript: /\.(c|m)?js$/,
  typescript: /\.(c|m)?(j|t)sx?$/,
  python: /\.py$/,
  c: /\.(c|h)$/,
  cpp: /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/,
  java: /\.java$/,
};

const CHECKERS: Record<Language, (code: string) => string[]> = {
  javascript: checkJavaScript,
  typescript: checkJavaScript,
  python: checkPython,
  c: checkC,
  cpp: checkC,
  java: checkJava,
};

export function checkProject(language: Language, files: Map<string, string>): string[] {
  const issues = new Set<string>();
  for (const [filePath, content] of files) {
    if (!SOURCE_EXTENSIONS[language].test(filePath)) continue;
    for (const issue of CHECKERS[language](content)) {
      issues.add(`${filePath}: ${issue}`);
    }
  }
  return [...issues];
}
