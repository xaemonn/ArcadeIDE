"use client";

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  useEffect,
} from "react";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Copy,
  Eraser,
  Keyboard,
  Loader,
  Terminal as TerminalIcon,
} from "lucide-react";
import clsx from "clsx";
import { getSocket } from "@/lib/socket";

export interface TerminalEntry {
  output?: string;
  error?: string;
  exitCode?: number | null;
  ranBy: string;
  timeStamp: string;
  durationMs?: number;
}

export interface TerminalRef {
  appendEntry: (entry: TerminalEntry) => void;
  setRunning: (running: boolean) => void;
  /** Text typed into the stdin box, passed to the program on Run. */
  getStdin: () => string;
}

interface TerminalProps {
  /** Called when a collaborator's run arrives, so the panel can be revealed. */
  onRemoteEntry?: () => void;
  height: number;
  setHeight: (h: number) => void;
  isExpanded: boolean;
  handleResize: (
    e: React.MouseEvent,
    startHeight: number,
    setHeight: (h: number) => void,
    min?: number,
    max?: number
  ) => void;
}

const LONG_OUTPUT = 500;

const isFailure = (entry: TerminalEntry) =>
  entry.exitCode !== undefined && entry.exitCode !== null
    ? entry.exitCode !== 0
    : Boolean(entry.error);

const Terminal = forwardRef<TerminalRef, TerminalProps>(
  ({ height, setHeight, isExpanded, handleResize, onRemoteEntry }, ref) => {
    const [isCopied, setIsCopied] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [expandedEntries, setExpandedEntries] = useState<Record<number, boolean>>({});
    const [log, setLog] = useState<TerminalEntry[]>([]);
    const [showStdin, setShowStdin] = useState(false);
    const [stdin, setStdin] = useState("");
    const scrollRef = useRef<HTMLDivElement>(null);
    const stdinRef = useRef("");
    stdinRef.current = stdin;
    const onRemoteEntryRef = useRef(onRemoteEntry);
    onRemoteEntryRef.current = onRemoteEntry;

    useImperativeHandle(ref, () => ({
      appendEntry: (entry) => setLog((prev) => [...prev, entry].slice(-100)),
      setRunning: (running) => setIsRunning(running),
      getStdin: () => stdinRef.current,
    }));

    const handleCopy = async () => {
      const latest = log[log.length - 1];
      if (!latest) return;
      const text = [latest.output, latest.error].filter(Boolean).join("\n").trim();
      if (!text) return;

      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    };

    const clearLog = () => {
      setLog([]);
      setExpandedEntries({});
    };

    useEffect(() => {
      const timeout = setTimeout(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      }, 0);
      return () => clearTimeout(timeout);
    }, [log, isRunning]);

    // Runs started by collaborators.
    useEffect(() => {
      const socket = getSocket();
      const handleTerminalUpdate = (payload: TerminalEntry) => {
        setLog((prev) =>
          [
            ...prev,
            {
              output: payload.output || "",
              error: payload.error || "",
              exitCode: payload.exitCode,
              ranBy: payload.ranBy || "Unknown",
              timeStamp:
                payload.timeStamp ||
                new Date().toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                  hour12: true,
                }),
            },
          ].slice(-100)
        );
        onRemoteEntryRef.current?.();
      };

      socket.on("terminal-update", handleTerminalUpdate);
      return () => {
        socket.off("terminal-update", handleTerminalUpdate);
      };
    }, []);

    const showBody = isExpanded || log.length > 0 || isRunning;

    return (
      <div style={{ height }} className="relative w-full flex flex-col bg-neutral-950 group">
        <div
          onMouseDown={(e) => handleResize(e, height, setHeight, 40, 500)}
          className="absolute top-0 left-0 w-full h-2 cursor-row-resize bg-transparent z-10"
          title="Drag to resize terminal"
        />

        <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 bg-neutral-900">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 flex items-center justify-center bg-neutral-800 rounded-lg">
              <TerminalIcon className="w-4 h-4 text-neutral-400 group-hover:text-blue-600" />
            </div>
            <span className="text-sm font-medium text-neutral-300">Terminal</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowStdin((v) => !v)}
              className={clsx(
                "flex items-center gap-1.5 text-xs px-3 py-1 rounded-md border transition",
                showStdin || stdin
                  ? "text-blue-300 border-blue-500/40 bg-blue-500/10"
                  : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 border-neutral-700"
              )}
              title="Text sent to the program's standard input"
            >
              <Keyboard className="w-3 h-3" />
              Input{stdin ? " •" : ""}
            </button>

            {log.length > 0 && (
              <>
                <button
                  onClick={clearLog}
                  className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 border border-neutral-700 transition"
                  title="Clear terminal output"
                >
                  <Eraser className="w-3 h-3" />
                  Clear
                </button>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 text-xs px-3 py-1 rounded-md text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 border border-neutral-700 transition"
                >
                  {isCopied ? (
                    <>
                      <CheckCircle className="w-3 h-3" /> Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copy
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {showStdin && (
          <div className="border-b border-neutral-800 bg-neutral-900/60 px-4 py-2">
            <textarea
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
              placeholder="Program input (stdin), one value per line…"
              rows={2}
              className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
          </div>
        )}

        {showBody ? (
          <div
            ref={scrollRef}
            className="relative bg-neutral-950/50 backdrop-blur-sm p-4 flex-1 overflow-auto text-sm"
          >
            {log.map((entry, i) => {
              const failed = isFailure(entry);
              const text = [entry.output, entry.error].filter(Boolean).join("\n");
              const isLong = text.length > LONG_OUTPUT;
              const expanded = expandedEntries[i];

              return (
                <div
                  key={i}
                  className={`mb-4 last:mb-0 p-4 rounded-lg border text-sm transition-all duration-200 animate-fade-in
                    ${failed ? "border-red-900/50 bg-red-950/20" : "border-emerald-900/50 bg-emerald-950/20"}`}
                >
                  <div className="flex items-center justify-between mb-2 text-xs text-neutral-400 italic">
                    <div className="flex items-center gap-2">
                      <span>
                        Ran by <span className="font-semibold text-neutral-200">{entry.ranBy}</span>
                      </span>
                      <span
                        className={`px-2 py-0.5 text-[10px] rounded-full font-bold uppercase tracking-wide not-italic ${
                          failed
                            ? "bg-red-500/10 text-red-400 border border-red-500/20"
                            : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                        }`}
                      >
                        {failed
                          ? entry.exitCode !== undefined && entry.exitCode !== null
                            ? `Exit ${entry.exitCode}`
                            : "Error"
                          : "Success"}
                      </span>
                      {entry.durationMs !== undefined && (
                        <span className="not-italic text-neutral-600">{entry.durationMs} ms</span>
                      )}
                    </div>
                    <span>{entry.timeStamp}</span>
                  </div>

                  <div className="flex items-start gap-2">
                    {failed ? (
                      <AlertTriangle className="text-red-400 w-4 h-4 mt-1 flex-shrink-0" />
                    ) : (
                      <CheckCircle className="text-emerald-400 w-4 h-4 mt-1 flex-shrink-0" />
                    )}
                    <div
                      className="flex-1 min-w-0 font-mono whitespace-pre-wrap break-words"
                      style={{
                        maxHeight: !expanded && isLong ? "180px" : "none",
                        overflow: !expanded && isLong ? "hidden" : "visible",
                      }}
                    >
                      {entry.output && <pre className="text-emerald-300 whitespace-pre-wrap">{entry.output}</pre>}
                      {entry.error && <pre className="text-red-300 whitespace-pre-wrap">{entry.error}</pre>}
                      {!entry.output && !entry.error && (
                        <span className="text-neutral-500 italic">(no output)</span>
                      )}
                    </div>
                  </div>

                  {isLong && (
                    <div className="mt-2 text-right">
                      <button
                        onClick={() => setExpandedEntries((prev) => ({ ...prev, [i]: !prev[i] }))}
                        className="text-xs text-blue-400 hover:underline cursor-pointer"
                      >
                        {expanded ? "Show less" : "Show more"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {isRunning && (
              <div className="flex items-center gap-3 py-3 text-neutral-400">
                <Loader className="w-4 h-4 text-blue-500 animate-spin" />
                <span className="text-sm">Running your code...</span>
              </div>
            )}

            {!isRunning && log.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-neutral-500">
                <div className="w-12 h-12 bg-neutral-900 rounded-lg flex items-center justify-center mb-2">
                  <Clock className="w-6 h-6" />
                </div>
                <p className="text-sm text-neutral-400">Run your code to see output here</p>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center flex-1 px-4 pb-3 pt-2 text-neutral-400 text-sm">
            <div className="flex flex-col items-center gap-2">
              <div className="w-12 h-12 bg-neutral-900 rounded-lg flex items-center justify-center">
                <Clock className="w-6 h-6" />
              </div>
              <p className="text-sm text-neutral-500">Run your code to see output here</p>
            </div>
          </div>
        )}
      </div>
    );
  }
);

Terminal.displayName = "Terminal";
export default Terminal;
