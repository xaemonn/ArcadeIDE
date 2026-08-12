"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import CodeEditor from "@/components/room/Editor";
import Navbar from "@/components/room/RoomNavbar";
import TabbedSidebar from "@/components/room/TabbedSidebar";
import Tabs from "@/components/room/Tabs";
import Terminal, { TerminalRef } from "@/components/room/Terminal";
import type { RevertResult } from "@/components/room/GitSidebar";
import { connectRoomSocket, disconnectRoomSocket, getSocket } from "@/lib/socket";
import { BACKEND_URL, execOnBackend } from "@/lib/backend";
import { buildPathMap, isExternalUrl, resolveRelativePath } from "@/lib/fileTree";
import { editorLanguage, runtimeLanguage } from "@/lib/languages";
import { useSession } from "next-auth/react";
import Link from "next/link";
import clsx from "clsx";
import type { FileData } from "@/types/FileData";
import ThemeSelector from "@/components/room/ThemeSelector";
import LivePreviewPane from "@/components/room/LivePreviewModal";
import {
  Check,
  Loader2,
  Lock,
  Maximize2,
  MessageSquareQuote,
  Minimize2,
  MonitorDot,
  Play,
  Redo,
  Undo,
  X,
} from "lucide-react";
import DiffView from "@/components/room/DiffView";
import { useRouter } from "next/navigation";
import MobileBlocker from "@/components/MobileBlocker";
import { Loader } from "@/components/Loader";
import toast from "react-hot-toast";

type Diff = {
  id: string;
  name: string;
  language: string;
  oldContent: string;
  content: string;
};

type Commit = {
  id: string;
  message: string;
  createdAt: string;
  user: { name: string; [key: string]: any };
  files: Diff[];
};

type ProjectSnapshot = {
  files: FileData[];
  paths: Map<string, string>;
  contents: Map<string, string>;
};

const BUNDLE_SOURCE = /\.(m?js|jsx|ts|tsx|json|css)$/i;

const timeStamp = () =>
  new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

// Cheap string hash used to skip re-bundling unchanged scripts.
function hashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36) + value.length.toString(36);
}

const escapeInlineScript = (code: string) => code.replace(/<\/script/gi, "<\\/script");

/** Ids of a file and, for folders, everything inside it. */
function withDescendants(files: FileData[], id: string): Set<string> {
  const ids = new Set([id]);
  let added = true;
  while (added) {
    added = false;
    for (const file of files) {
      if (file.parentId && ids.has(file.parentId) && !ids.has(file.id)) {
        ids.add(file.id);
        added = true;
      }
    }
  }
  return ids;
}

export default function RoomPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { data: session, status } = useSession();
  const router = useRouter();

  const [isSmallScreen, setIsSmallScreen] = useState<boolean | null>(null);
  const [files, setFiles] = useState<FileData[]>([]);
  const [roomName, setRoomName] = useState<string>("");
  const [roomId, setRoomId] = useState<string>("");
  const [accessError, setAccessError] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<FileData[]>([]);
  const [activeFile, setActiveFile] = useState<FileData | null>(null);
  const [theme, setTheme] = useState("vs-dark");
  const [isSaving, setIsSaving] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(40);
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Diff[]>([]);
  const [currentCommit, setCurrentCommit] = useState<Commit | null>(null);
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [pendingApplyRange, setPendingApplyRange] = useState<any>(null);
  const [diffSource, setDiffSource] = useState<"commit" | "ai" | null>(null);
  const [aiOutput, setAiOutput] = useState<string | null>(null);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [aiHeight, setAiHeight] = useState(200);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [running, setRunning] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [reloadSignal, setReloadSignal] = useState<{ fileIds: string[]; nonce: number } | null>(null);
  const terminalRef = useRef<TerminalRef>(null);
  const editorRef = useRef<any>(null);
  const previewDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const bundleCache = useRef(new Map<string, { code?: string; error?: string }>());
  const previewOpenRef = useRef(false);
  previewOpenRef.current = previewOpen;
  const activeFileRef = useRef<FileData | null>(null);
  activeFileRef.current = activeFile;

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push(`/login?callbackUrl=${encodeURIComponent(`/room/${slug}`)}`);
    }
  }, [status, router, slug]);

  useEffect(() => {
    const checkScreen = () => setIsSmallScreen(window.innerWidth < 1024);
    checkScreen();
    window.addEventListener("resize", checkScreen);
    return () => window.removeEventListener("resize", checkScreen);
  }, []);

  // One realtime connection per room; child components attach their listeners.
  useEffect(() => {
    if (status !== "authenticated" || !roomId) return;
    connectRoomSocket(slug);
    return () => disconnectRoomSocket();
  }, [status, roomId, slug]);

  useEffect(() => {
    if (!slug || status !== "authenticated") return;
    setLoading(true);

    const loadRoomAndFiles = async () => {
      try {
        const roomRes = await fetch(`/api/room/${slug}`);
        const roomData = await roomRes.json();
        if (!roomRes.ok) {
          setAccessError(roomData.error || "Room not available");
          return;
        }
        setRoomName(roomData.name);
        setRoomId(roomData.id);

        const filesRes = await fetch(`/api/room/${slug}/files`);
        const filesData = await filesRes.json();
        if (!filesRes.ok) throw new Error(filesData.error);
        setFiles(
          filesData.map((f: any) => ({
            id: f.id,
            name: f.name,
            parentId: f.parentId,
            type: f.type === "folder" ? "folder" : "file",
          }))
        );
      } catch (error) {
        console.error("Failed to load room:", error);
        setAccessError("Failed to load this room. Please try again.");
      } finally {
        setLoading(false);
      }
    };

    loadRoomAndFiles();
  }, [slug, status]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setIsSidebarOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const openFile = (file: FileData) => {
    if (file.type === "folder") return;
    setOpenTabs((prev) => (prev.find((f) => f.id === file.id) ? prev : [...prev, file]));
    setActiveFile(file);
  };

  const closeTabs = (ids: Set<string>) => {
    const remaining = openTabs.filter((f) => !ids.has(f.id));
    setOpenTabs(remaining);
    if (activeFile && ids.has(activeFile.id)) {
      setActiveFile(remaining[remaining.length - 1] ?? null);
    }
  };

  const closeFile = (fileId: string) => closeTabs(new Set([fileId]));

  const handleFileDeleted = (id: string) => {
    const removed = withDescendants(files, id);
    setFiles((prev) => prev.filter((f) => !removed.has(f.id)));
    closeTabs(removed);
  };

  const handleFileRenamed = (id: string, newName: string) => {
    const rename = (f: FileData) => (f.id === id ? { ...f, name: newName } : f);
    setFiles((prev) => prev.map(rename));
    setOpenTabs((prev) => prev.map(rename));
    setActiveFile((current) => (current ? rename(current) : current));
  };

  const hasHtml = files.some((f) => f.type === "file" && /\.html?$/i.test(f.name));
  const activeRuntime = activeFile ? runtimeLanguage(activeFile.name) : null;

  /** Latest content of every file; the open editor's text wins over the database. */
  const loadProjectSnapshot = async (): Promise<ProjectSnapshot> => {
    const res = await fetch(`/api/room/${slug}/files`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load files");

    const all: FileData[] = data.map((f: any) => ({
      ...f,
      type: f.type === "folder" ? "folder" : "file",
    }));
    const paths = buildPathMap(all);
    const contents = new Map<string, string>();
    for (const file of all) {
      if (file.type === "file") contents.set(paths.get(file.id)!, file.content ?? "");
    }

    const current = activeFileRef.current;
    const liveText = editorRef.current?.getModel?.() ? editorRef.current.getValue() : null;
    if (current && liveText !== null && paths.has(current.id)) {
      contents.set(paths.get(current.id)!, liveText);
    }
    return { files: all, paths, contents };
  };

  // Adds detected npm packages to the room's package.json.
  const updatePackageJson = async (
    dependencies: Record<string, string>,
    snapshot: ProjectSnapshot
  ) => {
    const existing = snapshot.files.find((f) => f.name === "package.json" && !f.parentId);
    let pkg: Record<string, any> = { name: slug, version: "1.0.0", private: true };
    if (existing) {
      try {
        pkg = JSON.parse(existing.content || "{}");
      } catch {
        return; // Never overwrite a package.json the user is editing by hand.
      }
    }

    const merged = { ...dependencies, ...(pkg.dependencies ?? {}) };
    if (JSON.stringify(merged) === JSON.stringify(pkg.dependencies ?? {})) return;
    const content = JSON.stringify({ ...pkg, dependencies: merged }, null, 2) + "\n";

    if (existing) {
      await fetch(`/api/file/${existing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      getSocket().emit("doc:reset", { fileIds: [existing.id] });
      setReloadSignal({ fileIds: [existing.id], nonce: Date.now() });
    } else {
      const res = await fetch(`/api/room/${slug}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "package.json", content, type: "file", parentId: null }),
      });
      if (!res.ok) return;
      const newFile = await res.json();
      setFiles((prev) => (prev.some((f) => f.id === newFile.id) ? prev : [...prev, newFile]));
      getSocket().emit("file-add", { file: newFile });
    }
  };

  // Inlines local stylesheets and bundles local scripts (npm imports included).
  const buildPreview = async (options: { silent?: boolean } = {}) => {
    const current = activeFileRef.current;
    const htmlFile =
      (current && /\.html?$/i.test(current.name) ? current : null) ??
      files.find((f) => f.name.toLowerCase() === "index.html" && !f.parentId) ??
      files.find((f) => f.type === "file" && /\.html?$/i.test(f.name));

    if (!htmlFile) {
      if (!options.silent) toast.error("Add an .html file to preview.");
      return;
    }

    if (!options.silent) setExecuting(true);
    try {
      const snapshot = await loadProjectSnapshot();
      const htmlPath = snapshot.paths.get(htmlFile.id);
      if (!htmlPath) throw new Error("HTML file not found");
      let html = snapshot.contents.get(htmlPath) ?? "";

      html = html.replace(/<link\b[^>]*>/gi, (tag) => {
        if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
        const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
        if (!href || isExternalUrl(href)) return tag;
        const css = snapshot.contents.get(resolveRelativePath(htmlPath, href));
        return css === undefined ? tag : `<style>\n${css}\n</style>`;
      });

      const bundleFiles: Record<string, string> = {};
      for (const [path, content] of snapshot.contents) {
        if (BUNDLE_SOURCE.test(path)) bundleFiles[path] = content;
      }
      const bundleKey = hashString(JSON.stringify(bundleFiles));

      const errors: string[] = [];
      let backendDown = false;
      const scriptTags = [
        ...html.matchAll(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi),
      ];

      for (const [tag, , src] of scriptTags) {
        if (isExternalUrl(src)) continue;
        const entry = resolveRelativePath(htmlPath, src);
        const source = snapshot.contents.get(entry);
        if (source === undefined) continue;

        const cacheKey = `${entry}:${bundleKey}`;
        let result = bundleCache.current.get(cacheKey);
        if (!result) {
          try {
            const { data } = await execOnBackend(slug, {
              mode: "preview",
              entry,
              files: bundleFiles,
            });
            result = { code: data.code, error: data.error };
            if (!data.error) bundleCache.current.set(cacheKey, result);
            if (bundleCache.current.size > 50) bundleCache.current.clear();
            if (data.packageJson?.dependencies) {
              updatePackageJson(data.packageJson.dependencies, snapshot).catch((err) =>
                console.warn("Failed to update package.json", err)
              );
            }
          } catch {
            // Backend unreachable: fall back to the raw script (works without imports).
            backendDown = true;
            result = { code: source };
          }
        }

        if (result.error) errors.push(result.error);
        else html = html.replace(tag, () => `<script>\n${escapeInlineScript(result!.code ?? "")}\n</script>`);
      }

      if (backendDown && !options.silent) {
        toast("Preview server unreachable; scripts were inlined without bundling.");
      }
      setPreviewHtml(html);
      setPreviewError(errors.length ? errors.join("\n\n") : null);
      setPreviewOpen(true);
    } catch (error) {
      console.error("Preview failed:", error);
      if (!options.silent) toast.error("Failed to load preview.");
    } finally {
      if (!options.silent) setExecuting(false);
    }
  };

  const buildPreviewRef = useRef(buildPreview);
  buildPreviewRef.current = buildPreview;

  // Live preview: rebuild shortly after anyone edits the open file.
  const handleEditorChange = useCallback(() => {
    if (!previewOpenRef.current) return;
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      buildPreviewRef.current({ silent: true });
    }, 900);
  }, []);

  const runCode = async () => {
    if (!activeFile || running) return;
    const language = runtimeLanguage(activeFile.name);
    if (!language) {
      toast.error("This file type cannot be run.");
      return;
    }

    if (!terminalExpanded) {
      setTerminalHeight(240);
      setTerminalExpanded(true);
    }
    setAiOutput(null);
    setRunning(true);
    terminalRef.current?.setRunning(true);

    const ranBy = session?.user.name || "Unknown user";
    let entry;
    try {
      const snapshot = await loadProjectSnapshot();
      const { ok, data } = await execOnBackend(slug, {
        language,
        mode: "execute",
        entry: snapshot.paths.get(activeFile.id) ?? activeFile.name,
        files: Object.fromEntries(snapshot.contents),
        stdin: terminalRef.current?.getStdin() ?? "",
      });

      const exitCode = data.exitCode ?? (ok ? 0 : 1);
      const error = data.stderr || (!ok ? data.error || "Execution failed." : "");
      entry = {
        output: data.stdout || "",
        error,
        exitCode,
        durationMs: data.durationMs,
        ranBy,
        timeStamp: timeStamp(),
      };
      setLastError(exitCode !== 0 ? error || data.stdout || "Program failed" : null);
    } catch (error) {
      console.error("Execution failed:", error);
      entry = {
        output: "",
        error: `Could not reach the code runner at ${BACKEND_URL}. If it is hosted on a free tier it may be waking up; try again in a few seconds.`,
        exitCode: null,
        ranBy,
        timeStamp: timeStamp(),
      };
    } finally {
      terminalRef.current?.setRunning(false);
      setRunning(false);
    }

    terminalRef.current?.appendEntry(entry);
    const socket = getSocket();
    if (socket.connected) socket.emit("terminal-output", entry);
  };

  const fetchCommitDetails = async (commitId: string) => {
    const res = await fetch(`/api/room/${slug}/commit/${commitId}`);
    if (!res.ok) throw new Error("Cannot fetch commit");
    return res.json();
  };

  const handleRevert = ({ fileIds, renamed }: RevertResult) => {
    const socket = getSocket();
    for (const { id, name } of renamed) {
      const current = files.find((f) => f.id === id);
      if (current && current.name !== name) {
        handleFileRenamed(id, name);
        if (socket.connected) socket.emit("file-rename", { fileId: id, newName: name });
      }
    }
    if (socket.connected) socket.emit("doc:reset", { fileIds });
    setReloadSignal({ fileIds, nonce: Date.now() });
  };

  const aiLanguage = () =>
    activeFile ? runtimeLanguage(activeFile.name) ?? editorLanguage(activeFile.name) : "javascript";

  const callAI = async (endpoint: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/ai/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "The AI assistant failed");
    return data;
  };

  const explainSelection = async () => {
    const editor = editorRef.current;
    if (!editor) {
      toast.error("Open a file first.");
      return;
    }

    const selection = editor.getModel()?.getValueInRange(editor.getSelection());
    if (!selection || selection.trim().length === 0) {
      toast.error("Please select some code first.");
      return;
    }

    try {
      const data = await callAI("explain", { code: selection, language: aiLanguage() });
      setAiOutput(data.explanation);
      setAiExpanded(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to explain the selected code.");
    }
  };

  const refactorSelection = async () => {
    const editor = editorRef.current;
    if (!editor) {
      toast.error("Open a file first.");
      return;
    }

    const selectionRange = editor.getSelection();
    const selection = editor.getModel()?.getValueInRange(selectionRange);
    if (!selection || selection.trim().length === 0) {
      toast.error("Please select some code first.");
      return;
    }

    try {
      const data = await callAI("refactor", { code: selection, language: aiLanguage() });
      setDiffs([
        {
          id: "ai-change",
          name: activeFile?.name || "current-file",
          oldContent: selection,
          content: data.result,
          language: activeFile ? editorLanguage(activeFile.name) : "plaintext",
        },
      ]);
      setPendingApplyRange(selectionRange);
      setDiffSource("ai");
      setShowDiffModal(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to refactor the selected code.");
    }
  };

  const addCommentsToSelection = async () => {
    const editor = editorRef.current;
    if (!editor) {
      toast.error("Open a file first.");
      return;
    }

    const range = editor.getSelection();
    const selection = editor.getModel()?.getValueInRange(range);
    const hasSelection = Boolean(selection && selection.trim().length > 0);
    const codeToComment = hasSelection ? selection : editor.getValue();

    try {
      const data = await callAI("comment", { code: codeToComment, language: aiLanguage() });
      // Routed through executeEdits so the change syncs and can be undone.
      editor.executeEdits("ai-comments", [
        {
          range: hasSelection ? range : editor.getModel().getFullModelRange(),
          text: data.result,
        },
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to comment the code.");
    }
  };

  const fixErrorsInFile = async () => {
    const editor = editorRef.current;
    if (!editor) {
      toast.error("Open a file first.");
      return;
    }

    const currentCode = editor.getValue();
    if (!lastError) {
      toast.error("No error to fix. Run the code first.");
      return;
    }

    try {
      const data = await callAI("fix", {
        code: currentCode,
        language: aiLanguage(),
        error: lastError,
      });
      setDiffs([
        {
          id: "ai-error-fix",
          name: activeFile?.name || "current-file",
          oldContent: currentCode,
          content: data.result,
          language: activeFile ? editorLanguage(activeFile.name) : "plaintext",
        },
      ]);

      setPendingApplyRange(editor.getModel()?.getFullModelRange());
      setDiffSource("ai");
      setShowDiffModal(true);
      setLastError(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to apply AI fix.");
    }
  };

  const handleResize = (
    e: React.MouseEvent,
    startHeight: number,
    setHeight: (h: number) => void,
    min = 40,
    max = 500
  ) => {
    const startY = e.clientY;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientY - startY;
      const newHeight = Math.max(min, Math.min(max, startHeight - delta));
      setHeight(newHeight);
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  if (isSmallScreen === null) {
    return null;
  }

  if (isSmallScreen) {
    return <MobileBlocker />;
  }

  if (accessError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-300">
        <div className="w-12 h-12 rounded-xl bg-neutral-900 border border-neutral-800 flex items-center justify-center">
          <Lock className="w-5 h-5 text-neutral-500" />
        </div>
        <p className="text-sm">{accessError}</p>
        <p className="text-xs text-neutral-500 max-w-sm text-center">
          Ask the room owner to invite you, or check that the link is correct.
        </p>
        <Link
          href="/rooms"
          className="mt-2 px-4 py-2 rounded-md bg-neutral-100 text-neutral-950 text-xs font-bold hover:bg-white transition"
        >
          Back to your rooms
        </Link>
      </div>
    );
  }

  if (status === "loading" || loading || !slug) return <Loader />;

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-50 overflow-hidden font-sans selection:bg-blue-500/30">
      {/* Header/Navbar */}
      <Navbar
        roomSlug={slug}
        roomName={roomName}
        handleExplain={explainSelection}
        handleRefactor={refactorSelection}
        handleComments={addCommentsToSelection}
        handleFix={fixErrorsInFile}
      />

      {/* Main Body */}
      <div className="flex flex-1 overflow-hidden">
        <div
          className={clsx(
            "flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
            isSidebarOpen ? "w-64 opacity-100" : "w-0 opacity-0"
          )}
        >
          {/* File Panel */}
          <TabbedSidebar
            files={files}
            onFileClick={openFile}
            slug={slug}
            roomId={roomId}
            activeFileId={activeFile?.id || null}
            onFileAdded={(file) =>
              setFiles((prev) =>
                prev.find((f) => f.id === file.id) ? prev : [...prev, file]
              )
            }
            onFileDeleted={handleFileDeleted}
            onFileRenamed={handleFileRenamed}
            onRevert={handleRevert}
            onPreview={async (commitId: string) => {
              try {
                const commitData = await fetchCommitDetails(commitId);
                setCurrentCommit(commitData);
                setDiffs(commitData.files);
                setDiffSource("commit");
                setShowDiffModal(true);
              } catch (err) {
                console.error("Failed to fetch commit:", err);
                toast.error("Could not load this commit.");
              }
            }}
          />
        </div>

        {/* Code Editor Section */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden border-l border-neutral-800">
          {/* Tabs */}
          <Tabs
            tabs={openTabs}
            activeFileId={activeFile?.id || ""}
            onTabClick={(file) => setActiveFile(file)}
            onClose={closeFile}
          />

          {/* Editor Toolbar */}
          <div className="flex items-center justify-between bg-neutral-900 px-4 py-2 border-b border-neutral-800 shadow-sm h-12">
            {/* Status & History Controls */}
            <div className="flex items-center gap-4">
              {/* Save Status */}
              <div className="text-xs w-16">
                {isTyping || isSaving ? (
                  <span className="text-blue-400 animate-pulse flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> Saving
                  </span>
                ) : (
                  <span className="text-neutral-500 flex items-center gap-1">
                    <Check className="w-3 h-3" /> Saved
                  </span>
                )}
              </div>

              {/* Undo / Redo */}
              <div className="flex items-center gap-1">
                <button
                  className="flex items-center gap-1 text-sm font-medium text-neutral-400 hover:text-neutral-100 bg-neutral-800 hover:bg-neutral-700 p-1.5 rounded transition cursor-pointer"
                  onClick={() => editorRef.current?.getAction?.("arcade.undo")?.run()}
                  title="Undo (Ctrl+Z)"
                >
                  <Undo className="w-4 h-4" />
                </button>
                <button
                  className="flex items-center gap-1 text-sm font-medium text-neutral-400 hover:text-neutral-100 bg-neutral-800 hover:bg-neutral-700 p-1.5 rounded transition cursor-pointer"
                  onClick={() => editorRef.current?.getAction?.("arcade.redo")?.run()}
                  title="Redo (Ctrl+Shift+Z)"
                >
                  <Redo className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Editor Actions */}
            <div className="flex items-center gap-3">
              <ThemeSelector theme={theme} setTheme={setTheme} />

              {hasHtml && (
                <button
                  onClick={() => buildPreview()}
                  disabled={executing}
                  className={`flex items-center gap-2 bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white
                  text-xs font-bold px-3 py-1.5 rounded-lg transition-all shadow-sm
                  ${executing ? "opacity-50 cursor-not-allowed" : ""}
                `}
                >
                  {executing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <MonitorDot className="w-3.5 h-3.5" />
                  )}
                  Preview
                </button>
              )}

              {activeRuntime && (
                <button
                  onClick={runCode}
                  disabled={running}
                  title={`Run ${activeFile?.name}`}
                  className={clsx(
                    "flex items-center gap-2 text-white bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 px-3 py-1.5 rounded-lg text-xs font-bold transition-all shadow-sm",
                    running && "opacity-60 cursor-not-allowed"
                  )}
                >
                  {running ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  )}
                  Run
                </button>
              )}
            </div>
          </div>

          {/* Editor + Terminal */}
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Editor View */}
            <div
              className="flex-1 overflow-hidden bg-neutral-950"
              style={{ height: "calc(100% - 40px)", pointerEvents: "auto" }}
            >
              {session && activeFile ? (
                <CodeEditor
                  key={activeFile.id}
                  fileId={activeFile.id}
                  fileName={activeFile.name}
                  theme={theme}
                  setIsSaving={setIsSaving}
                  setIsTyping={setIsTyping}
                  editorRef={editorRef}
                  onCodeChange={handleEditorChange}
                  reloadSignal={reloadSignal}
                />
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 h-full text-neutral-500 text-sm">
                  <span className="italic">Select a file to start coding</span>
                  {files.length === 0 && (
                    <span className="text-xs text-neutral-600">
                      Create one with the + button in the Explorer.
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Terminal / AI Output */}
            <div className="relative border-t border-neutral-800 bg-neutral-950">
              {aiOutput && (
                <div
                  style={{ height: aiExpanded ? aiHeight : 40 }}
                  className="relative w-full flex flex-col bg-neutral-950 group border-t border-neutral-800"
                >
                  {/* Drag Handle */}
                  {aiExpanded && (
                    <div
                      onMouseDown={(e) => handleResize(e, aiHeight, setAiHeight, 40, 500)}
                      className="absolute top-0 left-0 w-full h-1 cursor-row-resize bg-transparent hover:bg-blue-500/50 z-10 transition-colors"
                      title="Drag to resize"
                    />
                  )}

                  {/* Header */}
                  <div className="flex items-center justify-between px-4 h-10 border-b border-neutral-800 bg-neutral-900">
                    <div className="flex items-center gap-2">
                      <div className="p-1 bg-neutral-800 rounded text-neutral-400">
                        <MessageSquareQuote className="w-3.5 h-3.5 text-blue-400" />
                      </div>
                      <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider">
                        AI Assistant
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setAiExpanded(!aiExpanded)}
                        className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition"
                      >
                        {aiExpanded ? (
                          <Minimize2 className="w-3.5 h-3.5" />
                        ) : (
                          <Maximize2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        onClick={() => setAiOutput(null)}
                        className="p-1 rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800 transition"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Content */}
                  {aiExpanded && (
                    <div className="p-4 overflow-auto flex-1 text-sm text-neutral-300 bg-neutral-950 font-mono leading-relaxed">
                      <pre className="whitespace-pre-wrap break-words">{aiOutput}</pre>
                    </div>
                  )}
                </div>
              )}
              {/* Kept mounted so collaborators' runs are never missed. */}
              <div className={clsx(aiOutput && "hidden")}>
                <Terminal
                  ref={terminalRef}
                  onRemoteEntry={() => {
                    if (!terminalExpanded) {
                      setTerminalHeight(240);
                      setTerminalExpanded(true);
                    }
                  }}
                  height={terminalHeight}
                  setHeight={setTerminalHeight}
                  isExpanded={terminalExpanded}
                  handleResize={handleResize}
                />
              </div>
            </div>
          </div>
        </div>

        <div
          className={clsx(
            "flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out bg-neutral-950",
            previewOpen
              ? "w-[40%] opacity-100 border-l border-neutral-800"
              : "w-0 opacity-0 border-l-0"
          )}
        >
          {/* We keep the component mounted but hidden when width is 0 */}
          <div className="w-full h-full min-w-[300px]">
            <LivePreviewPane
              html={previewHtml}
              error={previewError}
              onRefresh={() => buildPreview()}
              onClose={() => setPreviewOpen(false)}
            />
          </div>
        </div>
      </div>

      {/* Diff Modal */}
      {showDiffModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center px-4 sm:px-6">
          <div className="relative bg-neutral-900 w-full max-w-5xl max-h-[90vh] overflow-hidden rounded-xl shadow-2xl border border-neutral-800 flex flex-col">
            {/* Header */}
            <div className="sticky top-0 z-20 bg-neutral-900 border-b border-neutral-800 flex justify-between items-center px-6 py-3">
              <div>
                <h2 className="text-neutral-100 text-sm font-bold uppercase tracking-wider">
                  Review Changes
                </h2>
                {diffSource === "commit" && currentCommit && (
                  <p className="text-xs text-neutral-500 mt-0.5">
                    Commit by{" "}
                    <span className="text-neutral-300">
                      {currentCommit.user?.name || "Unknown"}
                    </span>
                  </p>
                )}
              </div>
              <button
                onClick={() => setShowDiffModal(false)}
                className="p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Diffs */}
            <div className="overflow-y-auto flex-grow px-6 py-4 space-y-6 bg-neutral-950/50">
              {diffs.length === 0 ? (
                <p className="text-neutral-500 text-sm italic text-center py-10">
                  No changes to display.
                </p>
              ) : (
                diffs.map((file) => (
                  <DiffView
                    key={file.id}
                    fileName={file.name}
                    original={file.oldContent}
                    modified={file.content}
                    language={editorLanguage(file.name)}
                  />
                ))
              )}
            </div>

            {/* Footer Actions for AI Diffs */}
            {diffSource === "ai" && (
              <div className="border-t border-neutral-800 px-6 py-4 flex justify-end gap-3 bg-neutral-900 sticky bottom-0 z-10">
                <button
                  onClick={() => {
                    setShowDiffModal(false);
                    setPendingApplyRange(null);
                    setDiffs([]);
                    setDiffSource(null);
                  }}
                  className="px-4 py-2 rounded text-sm font-medium text-neutral-300 hover:text-white hover:bg-neutral-800 transition"
                >
                  Discard
                </button>
                <button
                  onClick={() => {
                    if (editorRef.current && pendingApplyRange && diffs[0]) {
                      editorRef.current.executeEdits("ai-apply", [
                        {
                          range: pendingApplyRange,
                          text: diffs[0].content,
                        },
                      ]);
                    }
                    setShowDiffModal(false);
                    setPendingApplyRange(null);
                    setDiffSource(null);
                    setDiffs([]);
                  }}
                  className="px-4 py-2 rounded text-sm font-bold bg-green-600 hover:bg-green-500 text-white shadow-sm transition"
                >
                  Apply Changes
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
