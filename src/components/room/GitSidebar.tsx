"use client";

import { useCallback, useEffect, useState } from "react";
import { Undo2, GitCommit, History, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import toast from "react-hot-toast";
import ConfirmModal from "@/components/ConfirmModal";

export interface RevertResult {
  fileIds: string[];
  renamed: { id: string; name: string }[];
}

interface GitSidebarProps {
  slug: string;
  onPreview?: (commitId: string) => void;
  onRevert?: (result: RevertResult) => void;
}

interface Commit {
  id: string;
  message: string;
  createdAt: string;
  user?: { name: string | null } | null;
}

interface FileStatus {
  id: string;
  name: string;
  status: "new" | "modified" | "unchanged";
}

const STATUS_STYLES: Record<FileStatus["status"], string> = {
  new: "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20",
  modified: "bg-amber-500/10 text-amber-500 border border-amber-500/20",
  unchanged: "bg-neutral-800 text-neutral-500 border border-neutral-800",
};

const STATUS_LABELS: Record<FileStatus["status"], string> = {
  new: "NEW",
  modified: "MOD",
  unchanged: "—",
};

export default function GitSidebar({ slug, onPreview, onRevert }: GitSidebarProps) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [commitToRevert, setCommitToRevert] = useState<Commit | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [commitsRes, statusRes] = await Promise.all([
        fetch(`/api/room/${slug}/commit`, { cache: "no-store" }),
        fetch(`/api/room/${slug}/status`, { cache: "no-store" }),
      ]);
      if (!commitsRes.ok || !statusRes.ok) throw new Error("Failed to load history");
      setCommits(await commitsRes.json());
      const statuses: FileStatus[] = await statusRes.json();
      setFiles(statuses);
      setSelectedFiles((prev) => prev.filter((id) => statuses.some((f) => f.id === id)));
    } catch (err) {
      console.error(err);
      toast.error("Could not load version history");
    } finally {
      setRefreshing(false);
    }
  }, [slug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const changedIds = files.filter((f) => f.status !== "unchanged").map((f) => f.id);

  async function createCommit() {
    if (!message.trim() || selectedFiles.length === 0) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/room/${slug}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, fileIds: selectedFiles }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Commit creation failed");

      if (!data.id) {
        toast(data.message || "No changes to commit");
      } else {
        setMessage("");
        setSelectedFiles([]);
        toast.success("Commit created");
      }
      await refresh();
    } catch (err) {
      console.error("Failed to create commit:", err);
      toast.error(err instanceof Error ? err.message : "Commit creation failed");
    } finally {
      setLoading(false);
    }
  }

  async function revertCommit(commit: Commit) {
    setCommitToRevert(null);
    try {
      const res = await fetch(`/api/room/${slug}/commit/${commit.id}/revert`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to revert commit");

      onRevert?.({ fileIds: data.fileIds ?? [], renamed: data.renamed ?? [] });
      await refresh();
      toast.success("Commit reverted");
    } catch (err) {
      console.error("Failed to revert commit:", err);
      toast.error(err instanceof Error ? err.message : "Failed to revert commit");
    }
  }

  function toggleFileSelection(fileId: string) {
    setSelectedFiles((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId]
    );
  }

  return (
    <div className="text-sm text-neutral-300 p-3 space-y-6 overflow-y-auto h-full bg-neutral-950 border-l border-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] uppercase tracking-widest text-neutral-500 flex items-center gap-2 font-bold select-none">
          <History className="w-3 h-3" /> Version Control
        </h2>
        <button
          onClick={refresh}
          title="Refresh"
          className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition"
        >
          <RefreshCw className={clsx("w-3 h-3", refreshing && "animate-spin")} />
        </button>
      </div>

      <div>
        <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-wider mb-1.5">
          Commit Message
        </label>
        <input
          type="text"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createCommit()}
          placeholder="Describe changes..."
          className="w-full px-3 py-2 bg-neutral-900 border border-neutral-800 text-neutral-200 rounded-md text-xs placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-blue-600 focus:border-blue-600 transition-colors"
        />
        <button
          onClick={createCommit}
          disabled={loading || !message.trim() || selectedFiles.length === 0}
          className="mt-3 w-full flex items-center justify-center gap-2 text-xs font-bold bg-blue-600 hover:bg-blue-500 text-white py-2 rounded-md disabled:bg-neutral-800 disabled:text-neutral-500 transition-colors"
        >
          {loading ? (
            <span className="animate-spin w-3 h-3 border-2 border-white/20 border-t-white rounded-full" />
          ) : (
            <GitCommit className="w-3.5 h-3.5" />
          )}
          Commit {selectedFiles.length > 0 ? `${selectedFiles.length} file${selectedFiles.length > 1 ? "s" : ""}` : "Changes"}
        </button>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">
            Files
          </span>
          {changedIds.length > 0 && (
            <button
              onClick={() => setSelectedFiles(changedIds)}
              className="text-[10px] text-blue-400 hover:underline"
            >
              Select changed ({changedIds.length})
            </button>
          )}
        </div>
        <ul className="space-y-0.5 max-h-48 overflow-auto pr-1">
          {files.length === 0 ? (
            <li className="text-neutral-600 text-xs italic text-center py-4">No files found</li>
          ) : (
            files.map((file) => {
              const isSelected = selectedFiles.includes(file.id);
              return (
                <li
                  key={file.id}
                  className={clsx(
                    "flex items-center justify-between gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none transition-colors",
                    isSelected ? "bg-neutral-900" : "hover:bg-neutral-900"
                  )}
                  onClick={() => toggleFileSelection(file.id)}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div
                      className={clsx(
                        "w-3.5 h-3.5 flex items-center justify-center border rounded transition-all",
                        isSelected
                          ? "bg-blue-600 border-blue-600"
                          : "border-neutral-600 bg-transparent hover:border-neutral-400"
                      )}
                    >
                      {isSelected && (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="w-2.5 h-2.5 text-white"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <span
                      className={clsx(
                        "truncate text-xs transition-colors",
                        isSelected ? "text-neutral-200" : "text-neutral-400"
                      )}
                    >
                      {file.name}
                    </span>
                  </div>

                  <span
                    className={clsx(
                      "text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider",
                      STATUS_STYLES[file.status]
                    )}
                  >
                    {STATUS_LABELS[file.status]}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      </div>

      <div>
        <h3 className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-3">
          Timeline
        </h3>
        <ul className="space-y-3 max-h-72 overflow-auto pr-1 relative border-l border-neutral-800 ml-1.5 pl-4">
          {commits.length === 0 ? (
            <li className="text-neutral-600 text-xs italic">No commits yet</li>
          ) : (
            commits.map((commit) => (
              <li key={commit.id} className="group relative">
                <div className="absolute -left-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-neutral-900 border border-neutral-700 group-hover:border-blue-500 group-hover:bg-blue-500/20 transition-colors" />

                <div className="flex justify-between items-start gap-2">
                  <div className="cursor-pointer flex-1 min-w-0" onClick={() => onPreview?.(commit.id)}>
                    <div className="text-neutral-300 text-xs font-medium truncate group-hover:text-blue-400 transition-colors">
                      {commit.message}
                    </div>
                    <div className="text-[10px] text-neutral-600 mt-0.5 truncate">
                      {commit.user?.name ? `${commit.user.name} · ` : ""}
                      {formatDistanceToNow(new Date(commit.createdAt), { addSuffix: true })}
                    </div>
                  </div>

                  <button
                    onClick={() => setCommitToRevert(commit)}
                    title="Revert to this commit"
                    className="opacity-0 group-hover:opacity-100 p-1 text-neutral-500 hover:text-red-400 hover:bg-red-950/30 rounded transition-all"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>

      <ConfirmModal
        isOpen={commitToRevert !== null}
        title="Revert to this commit?"
        message={
          <>
            Files in <span className="text-neutral-200">“{commitToRevert?.message}”</span> will be
            restored for everyone in the room. Uncommitted changes to those files are lost.
          </>
        }
        confirmLabel="Revert"
        onConfirm={() => commitToRevert && revertCommit(commitToRevert)}
        onCancel={() => setCommitToRevert(null)}
      />
    </div>
  );
}
