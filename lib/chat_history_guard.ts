import { createHash } from "node:crypto";
import { db } from "@/lib/db";

export type ChatHistorySnapshot = {
  chatId: string;
  count: number;
  signature: string;
};

function historyRows(chatId: string, limit = -1) {
  return db.prepare(
    `SELECT id, role, content, imagesJson, createdAt, updatedAt
     FROM messages WHERE chatId=? ORDER BY createdAt ASC, id ASC LIMIT ?`
  ).all(chatId, limit);
}

function signature(rows: unknown[]) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function captureChatHistory(chatId: string): ChatHistorySnapshot {
  const rows = historyRows(chatId);
  return { chatId, count: rows.length, signature: signature(rows) };
}

export class StaleChatHistoryError extends Error {
  constructor() {
    super("stale_source_changed");
    this.name = "StaleChatHistoryError";
  }
}

// Appending new turns is fine. Editing/deleting any source turn (including an
// earlier turn outside the selected summary window) invalidates the old result.
// The write lock makes the check + persistence atomic across both DOS servers.
export function withCurrentChatHistory<T>(snapshot: ChatHistorySnapshot, write: () => T): T {
  return db.transaction(() => {
    const rows = historyRows(snapshot.chatId, snapshot.count);
    if (rows.length !== snapshot.count || signature(rows) !== snapshot.signature) {
      throw new StaleChatHistoryError();
    }
    return write();
  }).immediate();
}
