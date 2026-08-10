"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Bug,
  ChevronDown,
  CloudOff,
  Download,
  Loader2,
  MessageSquareQuote,
  Mic,
  MicOff,
  StickyNote,
  Users,
  WandSparkles,
  Wrench,
} from "lucide-react";
import VoiceChatButton from "./Mic";
import toast from "react-hot-toast";
import { UserAvatar } from "../UserAvatar";
import { getSocket } from "@/lib/socket";

interface UserPresence {
  id: string;
  name: string;
  image?: string | null;
  muted: boolean;
}

type ConnectionState = "connecting" | "online" | "offline";

const MAX_VISIBLE_AVATARS = 5;

export default function RoomNavbar({
  roomSlug,
  roomName,
  handleExplain,
  handleRefactor,
  handleComments,
  handleFix,
}: {
  roomSlug: string;
  roomName: string;
  handleExplain: () => Promise<void> | void;
  handleRefactor: () => Promise<void> | void;
  handleComments: () => Promise<void> | void;
  handleFix: () => Promise<void> | void;
}) {
  const [users, setUsers] = useState<UserPresence[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [open, setOpen] = useState(false);
  const [AILoadingAction, setAILoadingAction] = useState<string | null>(null);
  const [zipLoading, setZIPLoading] = useState(false);
  const [showUserList, setShowUserList] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    let failures = 0;

    const onPresence = (onlineUsers: UserPresence[]) => {
      setUsers([...new Map(onlineUsers.map((u) => [u.id, u])).values()]);
    };
    const onConnect = () => {
      failures = 0;
      setConnection("online");
    };
    const onDisconnect = () => setConnection("connecting");
    // A sleeping free-tier backend can take a while to wake up.
    const onConnectError = () => {
      failures++;
      if (failures >= 3) setConnection("offline");
    };

    if (socket.connected) setConnection("online");
    socket.on("presence-update", onPresence);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    return () => {
      socket.off("presence-update", onPresence);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
    };
  }, []);

  const visibleUsers = users.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = users.length - visibleUsers.length;

  const handleAIAction = async (
    action: string,
    callback: () => Promise<void> | void
  ) => {
    setOpen(false);
    setAILoadingAction(action);

    try {
      await callback();
    } catch (err) {
      console.error(err);
    } finally {
      setAILoadingAction(null);
    }
  };

  const handleZIPDownload = async () => {
    const toastId = toast.loading("Preparing download...");
    try {
      setZIPLoading(true);

      const res = await fetch(`/api/room/${roomSlug}/export`);
      if (!res.ok) throw new Error("Failed to download project");

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${roomName || "project"}.zip`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Download failed:", error);
      toast.error("Failed to download project");
    } finally {
      setZIPLoading(false);
      toast.dismiss(toastId);
    }
  };

  return (
    <nav
      role="navigation"
      aria-label="Room navigation bar"
      className="sticky top-0 left-0 right-0 z-50 h-14 px-6 flex items-center justify-between bg-neutral-950/80 backdrop-blur-md border-b border-neutral-800"
    >
      <div className="flex items-center gap-3 text-neutral-200 min-w-0">
        <Link
          href="/rooms"
          title="Back to rooms"
          className="p-1.5 -ml-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <Users className="w-5 h-5 text-neutral-500 flex-shrink-0" aria-hidden="true" />
        <h1
          className="text-sm font-mono font-medium truncate select-text text-neutral-300"
          title={`Room: ${roomName}`}
        >
          {roomName}
        </h1>
        {connection === "offline" && (
          <span
            className="flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400"
            title="Live collaboration, voice and code execution need the realtime server. Editing and saving still work."
          >
            <CloudOff className="w-3 h-3" /> Realtime offline
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        <VoiceChatButton />

        <div className="relative">
          <button
            type="button"
            aria-haspopup="true"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider
               text-neutral-300 bg-neutral-900 border border-neutral-800
               hover:bg-neutral-50 hover:text-neutral-950 transition-colors duration-200 cursor-pointer"
          >
            {AILoadingAction ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {AILoadingAction === "explain" && "Explaining"}
                {AILoadingAction === "refactor" && "Refactoring"}
                {AILoadingAction === "comments" && "Adding"}
                {AILoadingAction === "fix" && "Fixing"}
                <span className="animate-pulse -ml-1">...</span>
              </>
            ) : (
              <>
                <WandSparkles className="w-4 h-4" />
                AI Actions
                <ChevronDown
                  className={`w-3 h-3 transition-transform ${open ? "rotate-180" : "rotate-0"}`}
                />
              </>
            )}
          </button>

          {open && (
            <div
              className="absolute right-0 mt-2 w-56 rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl z-50 overflow-hidden"
              role="menu"
            >
              <button
                onClick={() => handleAIAction("explain", handleExplain)}
                className="w-full px-4 py-2.5 text-sm text-left text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50 flex items-center gap-3 transition cursor-pointer"
                role="menuitem"
              >
                <MessageSquareQuote className="w-4 h-4 text-blue-400" />
                Explain Selection
              </button>
              <button
                onClick={() => handleAIAction("refactor", handleRefactor)}
                className="w-full px-4 py-2.5 text-sm text-left text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50 flex items-center gap-3 transition cursor-pointer"
                role="menuitem"
              >
                <Wrench className="w-4 h-4 text-purple-400" />
                Refactor Selection
              </button>
              <button
                onClick={() => handleAIAction("comments", handleComments)}
                className="w-full px-4 py-2.5 text-sm text-left text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50 flex items-center gap-3 transition cursor-pointer"
                role="menuitem"
              >
                <StickyNote className="w-4 h-4 text-amber-400" />
                Add Comments
              </button>
              <div className="h-px bg-neutral-800 my-1 mx-2" />
              <button
                onClick={() => handleAIAction("fix", handleFix)}
                className="w-full px-4 py-2.5 text-sm text-left text-neutral-300 hover:bg-neutral-800 hover:text-neutral-50 flex items-center gap-3 transition cursor-pointer"
                role="menuitem"
              >
                <Bug className="w-4 h-4 text-red-400" />
                Fix Errors
              </button>
            </div>
          )}
        </div>

        <button
          onClick={handleZIPDownload}
          disabled={zipLoading}
          title="Download Project as ZIP"
          className="p-2 rounded-md text-neutral-400 bg-neutral-900 border border-neutral-800
        hover:bg-neutral-800 hover:text-neutral-50 transition-colors duration-200 cursor-pointer"
        >
          {zipLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
        </button>

        {users.length > 0 ? (
          <button
            type="button"
            className="flex items-center -space-x-3 pl-2 cursor-pointer"
            aria-label={`${users.length} users online`}
            onClick={() => setShowUserList(!showUserList)}
          >
            {visibleUsers.map((user) => (
              <div key={user.id} className="ring-2 ring-neutral-950 rounded-full">
                <UserAvatar user={user} />
              </div>
            ))}
            {overflowCount > 0 && (
              <div
                className="w-9 h-9 rounded-full bg-neutral-800 text-neutral-400 flex items-center justify-center text-xs font-bold border-2 border-neutral-950 shadow-sm hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
                title={`${overflowCount} more users`}
                aria-hidden="true"
              >
                +{overflowCount}
              </div>
            )}
          </button>
        ) : (
          <span className="text-xs text-neutral-600 animate-pulse">
            {connection === "offline" ? "Solo mode" : "Connecting..."}
          </span>
        )}
      </div>

      {showUserList && (
        <div className="absolute right-4 top-14 w-64 rounded-lg border border-neutral-800 bg-neutral-900 shadow-2xl z-50 overflow-hidden">
          <div className="px-4 py-3 text-neutral-500 text-xs font-bold uppercase tracking-widest bg-neutral-950/50 border-b border-neutral-800">
            Online Users ({users.length})
          </div>
          <ul className="max-h-60 overflow-y-auto divide-y divide-neutral-800">
            {users.map((user) => (
              <li
                key={user.id}
                className="flex items-center gap-3 px-4 py-2.5 text-neutral-300 hover:bg-neutral-800 transition-colors"
              >
                <UserAvatar user={user} size="xs" />
                <span className="truncate flex-1 text-sm">{user.name}</span>

                {user.muted ? (
                  <MicOff className="w-3.5 h-3.5 text-neutral-600" />
                ) : (
                  <Mic className="w-3.5 h-3.5 text-emerald-500" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
