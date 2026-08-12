"use client";

import { useEffect, useRef, useState } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor, IDisposable, IRange } from "monaco-editor";
import * as Y from "yjs";
import { AlertTriangle, CloudOff, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { defineMonacoThemes } from "@/lib/monaco-themes";
import { initMonaco } from "@/lib/monaco-snippets";
import { editorLanguage } from "@/lib/languages";
import { colorForUser } from "@/lib/colors";
import { getSocket } from "@/lib/socket";

/**
 * Collaborative Monaco editor.
 *
 * Every open file is a Yjs document shared through the realtime backend, so
 * simultaneous edits merge instead of overwriting each other. The editor that
 * made a change autosaves the merged text through the REST API. Without a
 * backend connection it keeps working as a plain single-user editor.
 */

const LOCAL_ORIGIN = "local-editor";
const REMOTE_ORIGIN = "remote";
const SAVE_DELAY_MS = 1200;
const CURSOR_THROTTLE_MS = 60;

interface CodeEditorProps {
  fileId: string;
  fileName: string;
  theme: string;
  setIsSaving: (val: boolean) => void;
  setIsTyping: (val: boolean) => void;
  editorRef: React.MutableRefObject<any>;
  onCodeChange?: (code: string) => void;
  /** Bumped by the parent after files changed outside the editor (e.g. revert). */
  reloadSignal?: { fileIds: string[]; nonce: number } | null;
}

interface Binding {
  docId: string;
  doc: Y.Doc;
  text: Y.Text;
  undo: Y.UndoManager;
  destroy: () => void;
}

interface RemoteCursor {
  socketId: string;
  user: { id: string; name: string };
  anchor: unknown;
  head: unknown;
}

const toRange = (
  start: { lineNumber: number; column: number },
  end: { lineNumber: number; column: number }
): IRange => ({
  startLineNumber: start.lineNumber,
  startColumn: start.column,
  endLineNumber: end.lineNumber,
  endColumn: end.column,
});

const normalizeEol = (text: string) => text.replace(/\r\n?/g, "\n");

export default function CodeEditor({
  fileId,
  fileName,
  theme,
  setIsSaving,
  setIsTyping,
  editorRef,
  onCodeChange,
  reloadSignal,
}: CodeEditorProps) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [live, setLive] = useState(false);
  const [mounted, setMounted] = useState(false);

  const language = editorLanguage(fileName);
  const editorInstance = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const binding = useRef<Binding | null>(null);
  const applyingRemote = useRef(false);
  const cursors = useRef(new Map<string, RemoteCursor>());

  const lastSaved = useRef("");
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest callbacks without re-running the setup effect.
  const callbacks = useRef({ setIsSaving, setIsTyping, onCodeChange });
  callbacks.current = { setIsSaving, setIsTyping, onCodeChange };
  const reloadRef = useRef<() => void>(() => {});
  const initialReloadNonce = useRef(reloadSignal?.nonce);

  useEffect(() => {
    if (!mounted) return;
    const editor = editorInstance.current!;
    const monaco = monacoRef.current!;
    const model = editor.getModel()!;
    const socket = getSocket();
    let disposed = false;
    const subscriptions: IDisposable[] = [];

    model.setEOL(monaco.editor.EndOfLineSequence.LF);

    // ---- Persistence ------------------------------------------------------

    const save = async (keepalive = false) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      if (model.isDisposed()) return;
      const content = model.getValue();
      dirty.current = false;
      if (content === lastSaved.current) return;

      if (!keepalive) callbacks.current.setIsSaving(true);
      try {
        const res = await fetch(`/api/file/${fileId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, language }),
          keepalive,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Save failed");
        }
        lastSaved.current = content;
      } catch (err) {
        dirty.current = true;
        if (!keepalive) toast.error(err instanceof Error ? err.message : "Failed to save changes");
      } finally {
        if (!keepalive) callbacks.current.setIsSaving(false);
      }
    };

    const markDirty = () => {
      dirty.current = true;
      callbacks.current.setIsTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => callbacks.current.setIsTyping(false), 800);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(), SAVE_DELAY_MS);
    };

    const setModelText = (text: string) => {
      applyingRemote.current = true;
      try {
        model.applyEdits([{ range: model.getFullModelRange(), text }]);
      } finally {
        applyingRemote.current = false;
      }
    };

    // ---- Remote cursors ---------------------------------------------------

    const decorations = editor.createDecorationsCollection();
    const cursorStyles = document.createElement("style");
    document.head.appendChild(cursorStyles);

    const renderCursors = () => {
      const current = binding.current;
      const rules: string[] = [];
      const decos: MonacoEditor.IModelDeltaDecoration[] = [];

      for (const cursor of current ? cursors.current.values() : []) {
        const toPosition = (json: unknown) => {
          try {
            const absolute = Y.createAbsolutePositionFromRelativePosition(
              Y.createRelativePositionFromJSON(json),
              current!.doc
            );
            return absolute && absolute.type === current!.text
              ? model.getPositionAt(absolute.index)
              : null;
          } catch {
            return null;
          }
        };
        const anchor = toPosition(cursor.anchor);
        const head = toPosition(cursor.head);
        if (!anchor || !head) continue;

        const key = cursor.socketId.replace(/[^\w-]/g, "");
        const color = colorForUser(cursor.user.id);
        const headFirst = model.getOffsetAt(head) < model.getOffsetAt(anchor);
        const caretClass = `arcade-remote-caret arcade-caret-${key}`;

        decos.push({
          range: headFirst ? toRange(head, anchor) : toRange(anchor, head),
          options: {
            className: `arcade-sel-${key}`,
            beforeContentClassName: headFirst ? caretClass : undefined,
            afterContentClassName: headFirst ? undefined : caretClass,
            hoverMessage: { value: cursor.user.name },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
        rules.push(
          `.arcade-sel-${key}{background-color:${color}33}` +
            `.arcade-caret-${key}{border-color:${color}}` +
            `.arcade-caret-${key}::after{content:${JSON.stringify(cursor.user.name)};background:${color}}`
        );
      }

      decorations.set(decos);
      cursorStyles.textContent = rules.join("\n");
    };

    let lastCursorSent = 0;
    let cursorTimer: ReturnType<typeof setTimeout> | null = null;
    const sendCursor = () => {
      const current = binding.current;
      const selection = editor.getSelection();
      if (!current || !selection || !socket.connected) return;
      const relative = (lineNumber: number, column: number) =>
        Y.relativePositionToJSON(
          Y.createRelativePositionFromTypeIndex(
            current.text,
            model.getOffsetAt({ lineNumber, column })
          )
        );
      socket.emit("cursor-update", {
        fileId,
        anchor: relative(selection.selectionStartLineNumber, selection.selectionStartColumn),
        head: relative(selection.positionLineNumber, selection.positionColumn),
      });
      lastCursorSent = Date.now();
    };
    const scheduleCursor = () => {
      if (cursorTimer) return;
      const wait = Math.max(0, CURSOR_THROTTLE_MS - (Date.now() - lastCursorSent));
      cursorTimer = setTimeout(() => {
        cursorTimer = null;
        sendCursor();
      }, wait);
    };

    // ---- Yjs binding ------------------------------------------------------

    const createBinding = (docId: string, state: Uint8Array): Binding => {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      Y.applyUpdate(doc, state, REMOTE_ORIGIN);
      if (model.getValue() !== text.toString()) setModelText(text.toString());

      const undo = new Y.UndoManager(text, {
        trackedOrigins: new Set([LOCAL_ORIGIN]),
        captureTimeout: 400,
      });

      // Monaco -> Yjs
      const contentSub = model.onDidChangeContent((event) => {
        if (applyingRemote.current) return;
        doc.transact(() => {
          [...event.changes]
            .sort((a, b) => b.rangeOffset - a.rangeOffset)
            .forEach((change) => {
              if (change.rangeLength) text.delete(change.rangeOffset, change.rangeLength);
              if (change.text) text.insert(change.rangeOffset, change.text);
            });
        }, LOCAL_ORIGIN);
      });

      // Yjs -> Monaco (remote edits and undo/redo)
      const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
        if (transaction.origin === LOCAL_ORIGIN) return;
        applyingRemote.current = true;
        try {
          let index = 0;
          for (const op of event.delta) {
            if (op.retain !== undefined) {
              index += op.retain;
            } else if (typeof op.insert === "string") {
              const position = model.getPositionAt(index);
              model.applyEdits([{ range: toRange(position, position), text: op.insert }]);
              index += op.insert.length;
            } else if (op.delete !== undefined) {
              const start = model.getPositionAt(index);
              const end = model.getPositionAt(index + op.delete);
              model.applyEdits([{ range: toRange(start, end), text: "" }]);
            }
          }
        } finally {
          applyingRemote.current = false;
        }
        // Undo/redo are local edits and must be saved.
        if (transaction.origin instanceof Y.UndoManager) markDirty();
        callbacks.current.onCodeChange?.(model.getValue());
        renderCursors();
      };
      text.observe(observer);

      const onUpdate = (update: Uint8Array, origin: unknown) => {
        if (origin !== REMOTE_ORIGIN && socket.connected) {
          socket.emit("doc:update", { fileId, update });
        }
      };
      doc.on("update", onUpdate);

      return {
        docId,
        doc,
        text,
        undo,
        destroy: () => {
          contentSub.dispose();
          text.unobserve(observer);
          doc.off("update", onUpdate);
          undo.destroy();
          doc.destroy();
        },
      };
    };

    const joinDoc = () => {
      if (!socket.connected || disposed) return;
      socket.emit(
        "doc:join",
        { fileId, content: model.getValue() },
        (response: { docId?: string; state?: ArrayBuffer } | undefined) => {
          if (disposed || !response?.state || !response.docId) return;
          const state = new Uint8Array(response.state);
          const current = binding.current;

          if (current && current.docId === response.docId) {
            // Same server document as before a short disconnect: merge both ways
            // so edits made while offline are kept.
            Y.applyUpdate(current.doc, state, REMOTE_ORIGIN);
            const missing = Y.encodeStateAsUpdate(
              current.doc,
              Y.encodeStateVectorFromUpdate(state)
            );
            socket.emit("doc:update", { fileId, update: missing });
          } else {
            current?.destroy();
            binding.current = createBinding(response.docId, state);
          }
          setLive(true);
          sendCursor();
        }
      );
    };

    // ---- Wiring -----------------------------------------------------------

    subscriptions.push(
      model.onDidChangeContent(() => {
        if (applyingRemote.current) return;
        markDirty();
        callbacks.current.onCodeChange?.(model.getValue());
      }),
      editor.onDidChangeCursorSelection(scheduleCursor),
      editor.addAction({
        id: "arcade.undo",
        label: "Undo",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ],
        run: () => {
          if (binding.current) binding.current.undo.undo();
          else editor.trigger("arcade", "undo", null);
        },
      }),
      editor.addAction({
        id: "arcade.redo",
        label: "Redo",
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY,
        ],
        run: () => {
          if (binding.current) binding.current.undo.redo();
          else editor.trigger("arcade", "redo", null);
        },
      }),
      editor.addAction({
        id: "arcade.save",
        label: "Save",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          save();
        },
      })
    );

    const onRemoteUpdate = (payload: { fileId: string; update: ArrayBuffer }) => {
      if (payload.fileId !== fileId || !binding.current) return;
      Y.applyUpdate(binding.current.doc, new Uint8Array(payload.update), REMOTE_ORIGIN);
    };
    const onCursor = (cursor: RemoteCursor & { fileId: string }) => {
      if (cursor.fileId !== fileId) return;
      cursors.current.set(cursor.socketId, cursor);
      renderCursors();
    };
    const onCursorRemove = (payload: { socketId: string; fileId?: string }) => {
      if (payload.fileId && payload.fileId !== fileId) return;
      if (cursors.current.delete(payload.socketId)) renderCursors();
    };
    const onDisconnect = () => {
      setLive(false);
      cursors.current.clear();
      renderCursors();
    };

    const loadFromServer = async () => {
      const res = await fetch(`/api/file/${fileId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load file");
      const data = await res.json();
      return normalizeEol(data.content || "");
    };

    // Discards local state and reloads the file, e.g. after a commit revert.
    const reload = async () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      dirty.current = false;
      binding.current?.destroy();
      binding.current = null;
      cursors.current.clear();
      setLive(false);
      try {
        const content = await loadFromServer();
        if (disposed) return;
        setModelText(content);
        lastSaved.current = content;
        callbacks.current.onCodeChange?.(content);
        joinDoc();
      } catch {
        if (!disposed) toast.error("Failed to reload file");
      }
    };
    reloadRef.current = reload;

    const onReset = (payload: { fileIds: string[] }) => {
      if (payload.fileIds?.includes(fileId)) reload();
    };
    const onPageHide = () => {
      if (dirty.current) save(true);
    };

    socket.on("connect", joinDoc);
    socket.on("disconnect", onDisconnect);
    socket.on("doc:update", onRemoteUpdate);
    socket.on("doc:reset", onReset);
    socket.on("cursor-update", onCursor);
    socket.on("cursor-remove", onCursorRemove);
    window.addEventListener("pagehide", onPageHide);

    (async () => {
      try {
        const content = await loadFromServer();
        if (disposed) return;
        setModelText(content);
        lastSaved.current = content;
        setStatus("ready");
        callbacks.current.onCodeChange?.(content);
        joinDoc();
      } catch (err) {
        if (disposed) return;
        console.error(err);
        setStatus("error");
        toast.error("Failed to load file.");
      }
    })();

    return () => {
      disposed = true;
      if (dirty.current) save();
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (cursorTimer) clearTimeout(cursorTimer);
      callbacks.current.setIsTyping(false);

      socket.off("connect", joinDoc);
      socket.off("disconnect", onDisconnect);
      socket.off("doc:update", onRemoteUpdate);
      socket.off("doc:reset", onReset);
      socket.off("cursor-update", onCursor);
      socket.off("cursor-remove", onCursorRemove);
      window.removeEventListener("pagehide", onPageHide);
      if (socket.connected) socket.emit("doc:leave", { fileId });

      binding.current?.destroy();
      binding.current = null;
      cursors.current.clear();
      subscriptions.forEach((s) => s.dispose());
      decorations.clear();
      cursorStyles.remove();
    };
  }, [mounted, fileId, language]);

  // Reload when the parent reports an external change to this file.
  useEffect(() => {
    if (!reloadSignal || reloadSignal.nonce === initialReloadNonce.current) return;
    if (reloadSignal.fileIds.includes(fileId)) reloadRef.current();
  }, [reloadSignal, fileId]);

  return (
    <div className="h-full w-full flex flex-col bg-neutral-950 text-white">
      <div className="flex-1 relative">
        {status === "loading" && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-neutral-950/80 backdrop-blur-sm transition-all duration-200">
            <div className="flex flex-col items-center gap-3 animate-in fade-in zoom-in-95 duration-200">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
              <p className="text-sm font-medium text-neutral-400">Loading file...</p>
            </div>
          </div>
        )}

        {status === "ready" && !live && (
          <div
            className="absolute top-2 right-4 z-40 flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-400"
            title="Changes are still saved. Live collaboration resumes when the realtime server is reachable."
          >
            <CloudOff className="w-3 h-3" /> Offline
          </div>
        )}

        {status === "error" ? (
          <div className="flex items-center justify-center h-full text-red-400 text-sm gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span>Failed to load file.</span>
          </div>
        ) : (
          <Editor
            height="100%"
            path={fileId}
            theme={theme === "vs-light" ? "vs" : theme}
            language={language}
            defaultValue=""
            beforeMount={(monaco) => {
              defineMonacoThemes(monaco);
              initMonaco(monaco);
            }}
            onMount={(editor, monaco) => {
              editorInstance.current = editor;
              monacoRef.current = monaco;
              editorRef.current = editor;
              setMounted(true);
            }}
            options={{
              fontSize: 14,
              readOnly: status !== "ready",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              quickSuggestions: true,
              automaticLayout: true,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontLigatures: true,
              padding: { top: 16 },
            }}
          />
        )}
      </div>
    </div>
  );
}
