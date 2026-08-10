export type RuntimeLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "c"
  | "cpp"
  | "java";

const RUNTIME_BY_EXTENSION: Record<string, RuntimeLanguage> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  java: "java",
};

const EDITOR_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  java: "java",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  json: "json",
  md: "markdown",
  xml: "xml",
  svg: "xml",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  sh: "shell",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
};

const extensionOf = (fileName: string) =>
  fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";

/** Language the backend can execute for this file, or null. */
export function runtimeLanguage(fileName: string): RuntimeLanguage | null {
  return RUNTIME_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/** Monaco language id for syntax highlighting. */
export function editorLanguage(fileName: string): string {
  return EDITOR_BY_EXTENSION[extensionOf(fileName)] ?? "plaintext";
}
