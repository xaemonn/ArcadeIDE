"use client";

import { Mic, MicOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import toast from "react-hot-toast";
import { getSocket } from "@/lib/socket";

/**
 * Voice chat as a WebRTC full mesh. The backend only relays signaling
 * messages; audio flows peer to peer. Uses the "perfect negotiation" pattern
 * so either side can (re)negotiate, e.g. when someone unmutes.
 */

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  sender: RTCRtpSender | null;
}

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  // A TURN server is needed when users sit behind strict NATs/firewalls.
  const turn = process.env.NEXT_PUBLIC_TURN_URL;
  if (turn) {
    servers.push({
      urls: turn.split(",").map((url) => url.trim()),
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

const RemoteAudioPlayer = ({ stream }: { stream: MediaStream }) => {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.srcObject = stream;
      audioRef.current.play().catch(() => {});
    }
  }, [stream]);

  return <audio ref={audioRef} autoPlay controls={false} style={{ display: "none" }} />;
};

const VoiceChatButton = () => {
  const [isMuted, setIsMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const peers = useRef(new Map<string, Peer>());
  const localStream = useRef<MediaStream | null>(null);

  useEffect(() => {
    const socket = getSocket();
    const signal = (to: string, payload: Record<string, unknown>) =>
      socket.emit("voice:signal", { to, ...payload });

    const removePeer = (id: string) => {
      const peer = peers.current.get(id);
      if (!peer) return;
      peer.pc.close();
      peers.current.delete(id);
      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    };
    const removeAll = () => [...peers.current.keys()].forEach(removePeer);

    const getPeer = (id: string): Peer => {
      const existing = peers.current.get(id);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      const peer: Peer = {
        pc,
        // Deterministic and opposite on both ends.
        polite: (socket.id ?? "") < id,
        makingOffer: false,
        ignoreOffer: false,
        sender: null,
      };
      peers.current.set(id, peer);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) signal(id, { candidate: candidate.toJSON() });
      };
      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          signal(id, { description: pc.localDescription?.toJSON() });
        } catch (err) {
          console.warn("Voice negotiation failed:", err);
        } finally {
          peer.makingOffer = false;
        }
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStreams((prev) => ({ ...prev, [id]: stream }));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") pc.restartIce();
      };

      const track = localStream.current?.getAudioTracks()[0];
      if (track && localStream.current) {
        peer.sender = pc.addTrack(track, localStream.current);
      }
      return peer;
    };

    const onSignal = async ({
      from,
      description,
      candidate,
    }: {
      from: string;
      description: RTCSessionDescriptionInit | null;
      candidate: RTCIceCandidateInit | null;
    }) => {
      const peer = getPeer(from);
      const { pc } = peer;
      try {
        if (description) {
          const collision =
            description.type === "offer" &&
            (peer.makingOffer || pc.signalingState !== "stable");
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return;

          await pc.setRemoteDescription(description);
          if (description.type === "offer") {
            await pc.setLocalDescription();
            signal(from, { description: pc.localDescription?.toJSON() });
          }
        } else if (candidate) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            if (!peer.ignoreOffer) throw err;
          }
        }
      } catch (err) {
        console.warn("Voice signaling error:", err);
      }
    };

    const joinVoice = () => {
      removeAll();
      socket.emit("voice:join", (response: { peers?: { socketId: string }[] }) => {
        response?.peers?.forEach((peer) => getPeer(peer.socketId));
      });
      socket.emit("mic-status", { status: localStream.current ? "unmuted" : "muted" });
    };
    const onPeerJoined = ({ socketId }: { socketId: string }) => getPeer(socketId);
    const onPeerLeft = ({ socketId }: { socketId: string }) => removePeer(socketId);

    if (socket.connected) joinVoice();
    socket.on("connect", joinVoice);
    socket.on("disconnect", removeAll);
    socket.on("voice:peer-joined", onPeerJoined);
    socket.on("voice:peer-left", onPeerLeft);
    socket.on("voice:signal", onSignal);

    return () => {
      socket.off("connect", joinVoice);
      socket.off("disconnect", removeAll);
      socket.off("voice:peer-joined", onPeerJoined);
      socket.off("voice:peer-left", onPeerLeft);
      socket.off("voice:signal", onSignal);
      if (socket.connected) socket.emit("voice:leave");
      removeAll();
      localStream.current?.getTracks().forEach((track) => track.stop());
      localStream.current = null;
    };
  }, []);

  const toggleMic = async () => {
    const socket = getSocket();
    if (busy) return;

    if (isMuted) {
      setBusy(true);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        const track = stream.getAudioTracks()[0];
        localStream.current = stream;
        for (const peer of peers.current.values()) {
          if (peer.sender) await peer.sender.replaceTrack(track);
          else peer.sender = peer.pc.addTrack(track, stream);
        }
        socket.emit("mic-status", { status: "unmuted" });
        setIsMuted(false);
        if (!socket.connected) toast("Voice chat connects once the realtime server is reachable.");
      } catch (err) {
        console.error("Mic access denied:", err);
        toast.error("Microphone access was denied.");
      } finally {
        setBusy(false);
      }
    } else {
      for (const peer of peers.current.values()) {
        await peer.sender?.replaceTrack(null).catch(() => {});
      }
      localStream.current?.getTracks().forEach((track) => track.stop());
      localStream.current = null;
      socket.emit("mic-status", { status: "muted" });
      setIsMuted(true);
    }
  };

  return (
    <>
      <motion.button
        onClick={toggleMic}
        whileTap={{ scale: 0.95 }}
        title={isMuted ? "Unmute Mic" : "Mute Mic"}
        aria-pressed={!isMuted}
        className={`
          relative flex items-center justify-center w-9 h-9 rounded-lg border transition-all duration-300
          ${
            isMuted
              ? "bg-neutral-900 border-neutral-800 text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800"
              : "bg-emerald-500/10 border-emerald-500/20 text-emerald-500 shadow-[0_0_10px_-4px_rgba(16,185,129,0.5)]"
          }
        `}
      >
        <AnimatePresence mode="wait" initial={false}>
          {isMuted ? (
            <motion.div
              key="muted"
              initial={{ scale: 0.5, opacity: 0, rotate: -20 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={{ scale: 0.5, opacity: 0, rotate: 20 }}
              transition={{ duration: 0.15 }}
            >
              <MicOff className="w-4 h-4" />
            </motion.div>
          ) : (
            <motion.div
              key="unmuted"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="relative"
            >
              <Mic className="w-4 h-4" />
              <span className="absolute -inset-3 rounded-full border border-emerald-500/30 opacity-0 animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite]" />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.button>

      {Object.entries(remoteStreams).map(([peerId, stream]) => (
        <RemoteAudioPlayer key={peerId} stream={stream} />
      ))}
    </>
  );
};

export default VoiceChatButton;
