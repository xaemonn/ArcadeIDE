import path from "node:path";
import { build, type Loader, type Plugin } from "esbuild";
import { BadRequestError, normalizeProjectPath, parseProject } from "./files.js";
import { formatBuildError } from "./languages.js";

/**
 * Bundles the JavaScript of an HTML preview into one classic script.
 *
 * Relative imports are resolved against the room's files, bare imports
 * ("lodash", "dayjs", "react") are fetched from esm.sh and inlined, so the
 * result runs inside the preview iframe without a module loader.
 */

const CDN_ORIGIN = "https://esm.sh";
const CDN_TARGET = "es2020";
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 500;
const FETCH_TIMEOUT_MS = 15_000;

const RESOLVE_EXTENSIONS = [
  "",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".json",
  ".css",
  "/index.js",
  "/index.jsx",
  "/index.ts",
  "/index.tsx",
];

const LOADERS: Record<string, Loader> = {
  ".js": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
  ".json": "json",
  ".txt": "text",
  ".svg": "text",
};

interface CachedModule {
  contents: string;
  isCss: boolean;
}

const moduleCache = new Map<string, CachedModule>();
const versionCache = new Map<string, { version: string; at: number }>();

export interface PreviewResult {
  code?: string;
  packageJson?: Record<string, unknown>;
  error?: string;
}

function cssModule(css: string): string {
  return `(() => {
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(css)};
  document.head.appendChild(style);
})();`;
}

/** "lodash/debounce" -> "lodash", "@scope/pkg/x" -> "@scope/pkg". */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function fetchModule(url: string): Promise<CachedModule> {
  const cached = moduleCache.get(url);
  if (cached) {
    moduleCache.delete(url);
    moduleCache.set(url, cached);
    return cached;
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "ArcadeIDE-preview" },
  });
  if (!response.ok) {
    throw new Error(`Could not load ${url} (HTTP ${response.status})`);
  }
  const contents = await response.text();
  const isCss =
    (response.headers.get("content-type") ?? "").includes("text/css") ||
    new URL(url).pathname.endsWith(".css");

  const entry = { contents, isCss };
  moduleCache.set(url, entry);
  if (moduleCache.size > MAX_CACHE_ENTRIES) {
    moduleCache.delete(moduleCache.keys().next().value!);
  }
  return entry;
}

async function latestVersion(name: string): Promise<string> {
  const cached = versionCache.get(name);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.version;
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!response.ok) return "latest";
    const { version } = (await response.json()) as { version?: string };
    if (!version) return "latest";
    versionCache.set(name, { version: `^${version}`, at: Date.now() });
    return `^${version}`;
  } catch {
    return "latest";
  }
}

function cdnUrl(specifier: string) {
  return `${CDN_ORIGIN}/${specifier}?target=${CDN_TARGET}`;
}

function previewPlugin(files: Map<string, string>, dependencies: Set<string>): Plugin {
  const resolveInProject = (specifier: string, importer: string) => {
    const base = specifier.startsWith("/")
      ? specifier
      : path.posix.join(path.posix.dirname(importer), specifier);
    let normalized: string;
    try {
      normalized = normalizeProjectPath(base);
    } catch {
      return null;
    }
    for (const suffix of RESOLVE_EXTENSIONS) {
      if (files.has(normalized + suffix)) return normalized + suffix;
    }
    return null;
  };

  return {
    name: "arcade-preview",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        // Imports inside CDN modules are absolute paths on the CDN.
        if (args.namespace === "cdn") {
          const url = /^[./]/.test(args.path) || args.path.startsWith("https://")
            ? new URL(args.path, args.importer).href
            : cdnUrl(args.path);
          if (!url.startsWith(`${CDN_ORIGIN}/`)) {
            return { errors: [{ text: `Blocked import of ${url}` }] };
          }
          return { path: url, namespace: "cdn" };
        }

        if (args.kind === "entry-point") {
          return { path: normalizeProjectPath(args.path), namespace: "project" };
        }

        if (args.path.startsWith("https://") || args.path.startsWith("http://")) {
          if (!args.path.startsWith(`${CDN_ORIGIN}/`)) {
            return {
              errors: [{ text: `Only ${CDN_ORIGIN} URLs can be imported in the preview` }],
            };
          }
          return { path: args.path, namespace: "cdn" };
        }

        if (/^[./]/.test(args.path)) {
          const resolved = resolveInProject(args.path, args.importer);
          if (!resolved) {
            return {
              errors: [{ text: `Cannot find "${args.path}" in this room's files` }],
            };
          }
          return { path: resolved, namespace: "project" };
        }

        if (args.path.startsWith("node:")) {
          return { errors: [{ text: `"${args.path}" is not available in the browser` }] };
        }

        dependencies.add(packageName(args.path));
        return { path: cdnUrl(args.path), namespace: "cdn" };
      });

      pluginBuild.onLoad({ filter: /.*/, namespace: "project" }, (args) => {
        const contents = files.get(args.path) ?? "";
        const extension = path.posix.extname(args.path).toLowerCase();
        if (extension === ".css") return { contents: cssModule(contents), loader: "js" };
        return { contents, loader: LOADERS[extension] ?? "jsx" };
      });

      pluginBuild.onLoad({ filter: /.*/, namespace: "cdn" }, async (args) => {
        const mod = await fetchModule(args.path);
        return mod.isCss
          ? { contents: cssModule(mod.contents), loader: "js" }
          : { contents: mod.contents, loader: "js" };
      });
    },
  };
}

export async function bundlePreview(files: unknown, entry: unknown): Promise<PreviewResult> {
  let project: ReturnType<typeof parseProject>;
  try {
    project = parseProject(files, entry);
  } catch (error) {
    if (error instanceof BadRequestError) return { error: error.message };
    throw error;
  }

  const dependencies = new Set<string>();
  try {
    const result = await build({
      entryPoints: [project.entry],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2018",
      jsx: "automatic",
      minify: false,
      charset: "utf8",
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [previewPlugin(project.files, dependencies)],
    });

    const code = result.outputFiles[0]?.text ?? "";
    if (Buffer.byteLength(code) > MAX_BUNDLE_BYTES) {
      return { error: "The bundled preview is larger than 5 MB." };
    }

    let packageJson: Record<string, unknown> | undefined;
    if (dependencies.size > 0) {
      const names = [...dependencies].sort();
      const versions = await Promise.all(names.map(latestVersion));
      packageJson = {
        dependencies: Object.fromEntries(names.map((name, i) => [name, versions[i]])),
      };
    }

    return { code, packageJson };
  } catch (error) {
    return { error: formatBuildError(error) };
  }
}
