import { randomUUID } from "node:crypto";
import * as Y from "yjs";

/**
 * In-memory Yjs documents, one per open file.
 *
 * The first client to open a file seeds the document with the content it
 * loaded from the database. Every later client receives the live document
 * state instead, so concurrent edits merge without conflicts. Persistence
 * stays in the Next.js app: clients save the merged text through the REST API.
 */

export const TEXT_KEY = "content";

// Keep a document around briefly after the last editor leaves so a quick
// reload or tab switch does not reseed it from a not-yet-saved database row.
const IDLE_TTL_MS = 60_000;
const MAX_SEED_LENGTH = 2_000_000;

interface DocEntry {
  /** Changes whenever the document is recreated, so clients know whether merging is safe. */
  id: string;
  doc: Y.Doc;
  subscribers: Set<string>;
  idleTimer?: NodeJS.Timeout;
}

export class DocStore {
  private docs = new Map<string, DocEntry>();
  private bySocket = new Map<string, Set<string>>();

  private key(roomId: string, fileId: string) {
    return `${roomId}:${fileId}`;
  }

  /** Subscribes a socket to a file and returns the full document state. */
  join(
    roomId: string,
    fileId: string,
    socketId: string,
    initialContent: string
  ): { docId: string; state: Uint8Array } {
    const key = this.key(roomId, fileId);
    let entry = this.docs.get(key);

    if (!entry) {
      const doc = new Y.Doc();
      doc.getText(TEXT_KEY).insert(0, initialContent.slice(0, MAX_SEED_LENGTH));
      entry = { id: randomUUID(), doc, subscribers: new Set() };
      this.docs.set(key, entry);
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }

    entry.subscribers.add(socketId);
    let keys = this.bySocket.get(socketId);
    if (!keys) {
      keys = new Set();
      this.bySocket.set(socketId, keys);
    }
    keys.add(key);

    return { docId: entry.id, state: Y.encodeStateAsUpdate(entry.doc) };
  }

  /** Applies an update from a subscribed socket. Returns false if rejected. */
  applyUpdate(
    roomId: string,
    fileId: string,
    socketId: string,
    update: Uint8Array
  ): boolean {
    const entry = this.docs.get(this.key(roomId, fileId));
    if (!entry || !entry.subscribers.has(socketId)) return false;
    try {
      Y.applyUpdate(entry.doc, update, socketId);
      return true;
    } catch {
      return false;
    }
  }

  isSubscribed(roomId: string, fileId: string, socketId: string): boolean {
    return (
      this.docs.get(this.key(roomId, fileId))?.subscribers.has(socketId) ?? false
    );
  }

  leave(roomId: string, fileId: string, socketId: string) {
    const key = this.key(roomId, fileId);
    this.bySocket.get(socketId)?.delete(key);
    this.unsubscribe(key, socketId);
  }

  /** Removes a socket from every document. Returns the affected file ids. */
  leaveAll(socketId: string): string[] {
    const keys = this.bySocket.get(socketId);
    this.bySocket.delete(socketId);
    const fileIds: string[] = [];
    for (const key of keys ?? []) {
      this.unsubscribe(key, socketId);
      fileIds.push(key.slice(key.indexOf(":") + 1));
    }
    return fileIds;
  }

  /** Drops documents so the next join reseeds them from the database. */
  reset(roomId: string, fileIds: string[]) {
    for (const fileId of fileIds) {
      const key = this.key(roomId, fileId);
      const entry = this.docs.get(key);
      if (!entry) continue;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      for (const socketId of entry.subscribers) {
        this.bySocket.get(socketId)?.delete(key);
      }
      entry.doc.destroy();
      this.docs.delete(key);
    }
  }

  getText(roomId: string, fileId: string): string | null {
    return (
      this.docs.get(this.key(roomId, fileId))?.doc.getText(TEXT_KEY).toString() ??
      null
    );
  }

  get size() {
    return this.docs.size;
  }

  private unsubscribe(key: string, socketId: string) {
    const entry = this.docs.get(key);
    if (!entry) return;
    entry.subscribers.delete(socketId);
    if (entry.subscribers.size === 0 && !entry.idleTimer) {
      entry.idleTimer = setTimeout(() => {
        if (entry.subscribers.size === 0) {
          entry.doc.destroy();
          this.docs.delete(key);
        }
      }, IDLE_TTL_MS);
      entry.idleTimer.unref();
    }
  }
}
