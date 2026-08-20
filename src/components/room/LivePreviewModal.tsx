"use client";

import { ExternalLink, X, MonitorPlay, RotateCw, SquareTerminal } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";

type Props = {
  /** HTML with the room's CSS and bundled JS already inlined. */
  html: string;
  onClose: () => void;
  onRefresh?: () => void;
  error?: string | null;
};

type ConsoleLine = { level: "log" | "info" | "warn" | "error"; text: string };

// User code runs in an opaque origin (no allow-same-origin), so it can never
// reach the app's cookies or API. Console output is forwarded with postMessage.
const SANDBOX = "allow-scripts allow-modals allow-forms allow-popups";

const SYSTEM_SCRIPT = `<script>
(() => {
  const send = (level, args) => {
    try {
      const text = args.map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
        return String(a);
      }).join(" ");
      parent.postMessage({ __arcadePreview: true, level, text }, "*");
    } catch {}
  };
  ["log", "info", "warn", "error"].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => { send(level, args); original(...args); };
  });
  window.addEventListener("error", (e) => send("error", [e.error || e.message]));
  window.addEventListener("unhandledrejection", (e) => send("error", ["Unhandled promise rejection:", e.reason]));
  document.addEventListener("DOMContentLoaded", () => {
    // Keep in-page anchor links from navigating the iframe away.
    document.body.addEventListener("click", (e) => {
      const link = e.target.closest && e.target.closest('a[href^="#"]');
      if (!link) return;
      e.preventDefault();
      const target = document.getElementById(link.getAttribute("href").slice(1));
      if (target) target.scrollIntoView({ behavior: "smooth" });
    });
    document.querySelectorAll("form:not([action])").forEach((form) => {
      form.setAttribute("action", "javascript:void(0);");
    });
  });
})();
</script>`;

function buildDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) {
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${SYSTEM_SCRIPT}`);
    }
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${SYSTEM_SCRIPT}</head>`);
  }
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>html, body { min-height: 100%; margin: 0; } *, *::before, *::after { box-sizing: border-box; }</style>
    ${SYSTEM_SCRIPT}
  </head>
  <body>${html}</body>
</html>`;
}

function errorDocument(error: string): string {
  const escaped = error.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<html><body style="background:#0a0a0a;color:#f87171;font-family:monospace;padding:20px;box-sizing:border-box;">
<h3 style="margin-top:0;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#ef4444;">⚠️ Build Error</h3>
<pre style="background:#171717;padding:15px;border-radius:8px;border:1px solid #262626;overflow-x:auto;white-space:pre-wrap;">${escaped}</pre>
</body></html>`;
}

export default function LivePreviewPane({ html, onClose, onRefresh, error = null }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [showConsole, setShowConsole] = useState(false);

  const srcDoc = useMemo(
    () => (error ? errorDocument(error) : buildDocument(html || "")),
    [html, error]
  );

  useEffect(() => {
    setConsoleLines([]);
  }, [srcDoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data?.__arcadePreview) return;
      setConsoleLines((prev) =>
        [...prev, { level: data.level, text: String(data.text).slice(0, 2000) }].slice(-200)
      );
      if (data.level === "error") setShowConsole(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const openInNewTab = () => {
    // The tab itself only hosts a sandboxed iframe, so user code stays isolated.
    const wrapper = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ArcadeIDE Preview</title>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style></head>
<body><iframe sandbox="${SANDBOX}" srcdoc="${srcDoc.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></body></html>`;
    const url = URL.createObjectURL(new Blob([wrapper], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const errorCount = consoleLines.filter((l) => l.level === "error").length;

  return (
    <div className="h-full flex flex-col bg-neutral-950 border-l border-neutral-800 w-full select-none">
      <div className="h-10 flex items-center justify-between px-3 border-b border-neutral-800 bg-neutral-900/50 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MonitorPlay className="w-3.5 h-3.5 text-blue-500" />
          <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">
            Browser Preview
          </span>

          <div className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
            <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[9px] font-bold text-emerald-500 uppercase">Live</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowConsole((v) => !v)}
            title="Preview console"
            className={clsx(
              "relative p-1.5 rounded-md transition-colors",
              showConsole
                ? "text-neutral-200 bg-neutral-800"
                : "text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800"
            )}
          >
            <SquareTerminal className="w-3.5 h-3.5" />
            {errorCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-red-500 text-[8px] font-bold text-white flex items-center justify-center">
                {errorCount}
              </span>
            )}
          </button>
          {onRefresh && (
            <button
              onClick={onRefresh}
              title="Rebuild preview"
              className="p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-md transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={openInNewTab}
            title="Open in New Tab"
            className="p-1.5 text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 rounded-md transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-3 bg-neutral-800 mx-1" />

          <button
            onClick={onClose}
            title="Close Preview"
            className="p-1.5 text-neutral-500 hover:text-red-400 hover:bg-red-950/20 rounded-md transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 bg-white relative min-h-0">
        <iframe
          ref={iframeRef}
          className="w-full h-full border-none block"
          srcDoc={srcDoc}
          sandbox={SANDBOX}
          title="Live Preview"
        />
      </div>

      {showConsole && (
        <div className="h-40 flex-shrink-0 border-t border-neutral-800 bg-neutral-950 flex flex-col select-text">
          <div className="flex items-center justify-between px-3 h-7 border-b border-neutral-800 text-[10px] font-bold uppercase tracking-widest text-neutral-500">
            Console
            <button
              onClick={() => setConsoleLines([])}
              className="normal-case tracking-normal font-medium text-neutral-500 hover:text-neutral-200"
            >
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-auto font-mono text-xs px-3 py-1.5 space-y-0.5">
            {consoleLines.length === 0 ? (
              <p className="text-neutral-600 italic">No console output.</p>
            ) : (
              consoleLines.map((line, i) => (
                <pre
                  key={i}
                  className={clsx(
                    "whitespace-pre-wrap break-words",
                    line.level === "error" && "text-red-400",
                    line.level === "warn" && "text-amber-300",
                    (line.level === "log" || line.level === "info") && "text-neutral-300"
                  )}
                >
                  {line.text}
                </pre>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
