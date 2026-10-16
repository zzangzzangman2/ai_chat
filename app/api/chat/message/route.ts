import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { captureChatHistory, StaleChatHistoryError, withCurrentChatHistory } from "@/lib/chat_history_guard";
import { getSessionUser } from "@/lib/auth";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import {
  extractSummarySections,
  normalizeStoredMemorySummary,
  strlenSummary,
} from "@/app/api/chat/send/_server/summaryStored";

function jsonError(msg: string, status: number = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type MsgRow = {
  id: string;
  chatId: string;
  role: "user" | "assistant" | string;
  createdAt: number;
  chatOwner: string;
};

// B-mode long memory policy: fixed 3 assistant turns per window.
const SUMMARY_EVERY_ASSISTANT_TURNS = 3;

function isAssistantLikeRole(role: any) {
  const r = String(role || "").toLowerCase();
  return r === "assistant" || r === "model";
}

function countAssistantTurnsUpToIndex(ordered: Array<{ role: string }>, idxInclusive: number) {
  const firstUserPos = ordered.findIndex((m) => String(m?.role || "") === "user");
  if (firstUserPos < 0) return 0;
  let turns = 0;
  for (let i = firstUserPos; i <= idxInclusive && i < ordered.length; i++) {
    if (isAssistantLikeRole(ordered[i]?.role)) turns++;
  }
  return turns;
}

function findNextAssistantIndex(ordered: Array<{ role: string }>, idx: number) {
  for (let i = Math.max(0, idx + 1); i < ordered.length; i++) {
    if (isAssistantLikeRole(ordered[i]?.role)) return i;
  }
  return -1;
}

function computeAffectedAssistantTurn(ordered: Array<{ role: string }>, idx: number) {
  const role = String(ordered[idx]?.role || "");
  if (isAssistantLikeRole(role)) {
    return countAssistantTurnsUpToIndex(ordered, idx);
  }
  if (role === "user") {
    const nextAsstIdx = findNextAssistantIndex(ordered, idx);
    if (nextAsstIdx >= 0) return countAssistantTurnsUpToIndex(ordered, nextAsstIdx);
    // Editing/deleting the last user message (no assistant yet) shouldn't invalidate existing long memory.
    return 0;
  }
  return 0;
}

function computeTruncateEndTurn(affectedAssistantTurn: number) {
  const t = Math.max(0, Math.floor(Number(affectedAssistantTurn) || 0));
  if (t <= 0) return 0;
  // Drop windows that include the affected turn and all after it.
  // Keep only windows fully BEFORE the affected turn.
  return Math.floor((t - 1) / SUMMARY_EVERY_ASSISTANT_TURNS) * SUMMARY_EVERY_ASSISTANT_TURNS;
}

function trimLongMemorySummaryToEnd(summary: string, endTurn: number) {
  const src = normalizeStoredMemorySummary(String(summary || ""), SUMMARY_EVERY_ASSISTANT_TURNS);
  if (!src.trim()) return { summary: "", endTurn: 0 };
  const secs = extractSummarySections(src).sort((a, b) => a.startTurn - b.startTurn);

  const kept: typeof secs = [];
  let expectedStart = 1;
  for (const s of secs) {
    if (s.startTurn !== expectedStart) break;
    if (s.endTurn > endTurn) break;
    kept.push(s);
    expectedStart = s.endTurn + 1;
  }

  const maxEnd = kept.length ? kept[kept.length - 1].endTurn : 0;
  if (maxEnd <= 0) return { summary: "", endTurn: 0 };

  const header = `## 장기 기억 (1-${maxEnd}턴)`;
  const body = kept
    .map((s) => `### ${s.title} (${s.startTurn}-${s.endTurn}턴)\n${s.body}`.trim())
    .join("\n\n");
  return { summary: `${header}\n\n${body}`.trim(), endTurn: maxEnd };
}

function trimLongMemoryCache(chatId: string, truncateEndTurn: number) {
    const row = db
      .prepare(
        `SELECT recentSummary, rolledUpCount FROM chat_memory_cache WHERE chatId=?`
      )
      .get(chatId) as any;
    if (!row) return;

    const raw = decryptIfPossible(String(row?.recentSummary || ""));
    const rolledUpCount = Math.max(0, Number(row?.rolledUpCount || 0));

    if (truncateEndTurn <= 0) {
      db.prepare(`DELETE FROM chat_memory_cache WHERE chatId=?`).run(chatId);
      return;
    }

    const trimmed = trimLongMemorySummaryToEnd(raw, truncateEndTurn);
    if (!trimmed.summary.trim() || trimmed.endTurn <= 0) {
      db.prepare(`DELETE FROM chat_memory_cache WHERE chatId=?`).run(chatId);
      return;
    }

    const now = Date.now();
    const chars = strlenSummary(trimmed.summary);

    db.prepare(
      `INSERT INTO chat_memory_cache (chatId, recentSummary, summarizedEndTurn, rolledUpCount, lastSummarizedAt, updatedAt, recentSummaryChars)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chatId) DO UPDATE SET
         recentSummary=excluded.recentSummary,
         summarizedEndTurn=excluded.summarizedEndTurn,
         rolledUpCount=excluded.rolledUpCount,
         lastSummarizedAt=excluded.lastSummarizedAt,
         updatedAt=excluded.updatedAt,
         recentSummaryChars=excluded.recentSummaryChars`
    ).run(
      chatId,
      encryptIfPossible(trimmed.summary),
      trimmed.endTurn,
      rolledUpCount,
      now,
      now,
      chars
    );
}

function invalidateDerivedMemory(chatId: string, affectedTurn: number, sourceIndex: number, derivedTurn: number) {
  if (affectedTurn > 0) {
    const truncateEndTurn = computeTruncateEndTurn(affectedTurn);
    trimLongMemoryCache(chatId, truncateEndTurn);
    db.prepare(`DELETE FROM chat_memory_blocks WHERE chatId=? AND endTurn>?`).run(chatId, truncateEndTurn);
    // Per-turn records do not need to discard the earlier turns in a 3-turn window.
    db.prepare(`DELETE FROM chat_character_turn_memories WHERE chatId=? AND turnNo>=?`).run(chatId, affectedTurn);
    db.prepare(`DELETE FROM chat_character_facts WHERE chatId=? AND turnNo>=?`).run(chatId, affectedTurn);
    db.prepare(`DELETE FROM chat_character_events WHERE chatId=? AND turnNo>=?`).run(chatId, affectedTurn);
    // These tables keep the latest value, not a complete history. Drop affected
    // automatic values so they cannot be reused as evidence for the next reply.
  }
  db.prepare(`DELETE FROM chat_character_relations WHERE chatId=? AND lastSeenTurn>=? AND slotKey NOT LIKE 'manual:%'`).run(chatId, derivedTurn);
  db.prepare(`DELETE FROM chat_character_affinity WHERE chatId=? AND lastTurnNo>=?`).run(chatId, derivedTurn);
  // A pending user turn can already have updated these before an answer exists.
  db.prepare(`DELETE FROM chat_character_vitals WHERE chatId=? AND sourceOrder>=?`).run(chatId, sourceIndex);
  db.prepare(`DELETE FROM chat_spatial_states WHERE chatId=? AND sourceOrder>=?`).run(chatId, sourceIndex);
}

function getMsgWithOwner(messageId: string): MsgRow | null {
  const row = db
    .prepare(
      `SELECT m.id as id, m.chatId as chatId, m.role as role, m.createdAt as createdAt, c.userEmail as chatOwner
       FROM messages m
       JOIN chats c ON c.id = m.chatId
       WHERE m.id = ?`
    )
    .get(messageId) as any;
  if (!row) return null;
  return {
    id: String(row.id),
    chatId: String(row.chatId),
    role: String(row.role),
    createdAt: Number(row.createdAt) || 0,
    chatOwner: String(row.chatOwner || ""),
  };
}

export async function PATCH(req: Request) {
  try {
    const u = await getSessionUser();
    if (!u) return jsonError("unauthorized", 401);

    const body = await req.json();
    const messageId = String(body?.messageId || "").trim();
    const content = String(body?.content || "").trim();
    if (!messageId) return jsonError("messageId required");
    if (!content) return jsonError("content required");

    const msg = getMsgWithOwner(messageId);
    if (!msg) {
      // idempotent: if already deleted, treat as success to avoid UI "message not found" alerts
      return NextResponse.json({ ok: true, deleted: [], alreadyDeleted: true });
    }
    if (msg.chatOwner !== u.email) return jsonError("forbidden", 403);
    // Allow editing both user and assistant messages.
    // (Some story/simulation workflows require manual fixes to assistant outputs.)
    const role = String(msg.role || "");
    if (role !== "user" && role !== "assistant") {
      return jsonError("only user/assistant messages can be edited", 400);
    }

    db.transaction(() => {
    db.prepare(`UPDATE messages SET content=?, updatedAt=?, userEmail=? WHERE id=?`).run(
      encryptIfPossible(content),
      Date.now(),
      u.email,
      messageId
    );

    // IMPORTANT: Editing a past message must invalidate derived caches.
    // However, deleting *all* long memory feels like "장기기억 전체 초기화".
    // Instead, we **truncate** long memory to the last safe window before the edited point,
    // so only the affected ranges are regenerated.
      const cid = msg.chatId;

      const ordered = db
        .prepare(`SELECT id, role, createdAt FROM messages WHERE chatId=? ORDER BY createdAt ASC, id ASC`)
        .all(cid) as any[];
      const idx = ordered.findIndex((r) => String(r.id) === messageId);
      const affectedTurn = idx >= 0 ? computeAffectedAssistantTurn(ordered, idx) : 0;

      // If the edit does not affect any assistant turn (e.g. editing the last user message
      // before an assistant reply exists), we keep existing long memory intact.
      if (idx >= 0) invalidateDerivedMemory(cid, affectedTurn, idx,
        affectedTurn || countAssistantTurnsUpToIndex(ordered, idx) + 1);
    }).immediate();

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return jsonError(e?.message || "error", 500);
  }
}

export async function DELETE(req: Request) {
  try {
    const u = await getSessionUser();
    if (!u) return jsonError("unauthorized", 401);

    const { searchParams } = new URL(req.url);
    const messageId = String(searchParams.get("messageId") || "").trim();
    if (!messageId) return jsonError("messageId required");

    const msg = getMsgWithOwner(messageId);
    if (!msg) {
      // idempotent: already deleted
      return NextResponse.json({ ok: true, deleted: [], alreadyDeleted: true });
    }
    if (msg.chatOwner !== u.email) return jsonError("forbidden", 403);

    const historySnapshot = captureChatHistory(msg.chatId);
    const ordered = db
      .prepare(`SELECT id, role, createdAt FROM messages WHERE chatId=? ORDER BY createdAt ASC, id ASC`)
      .all(msg.chatId) as any[];

    const idx = ordered.findIndex((r) => String(r.id) === messageId);
    if (idx < 0) return jsonError("message not found", 404);

    const idsToDelete = new Set<string>([messageId]);

    // "한 문단" 삭제 규칙
    // - assistant를 지우면 직전 user도 함께 삭제
    // - user를 지우면 직후 assistant도 함께 삭제
    const curRole = String(ordered[idx]?.role || "");
    if (isAssistantLikeRole(curRole)) {
      const prev = ordered[idx - 1];
      if (prev && String(prev.role) === "user") idsToDelete.add(String(prev.id));
    } else if (curRole === "user") {
      const next = ordered[idx + 1];
      if (next && isAssistantLikeRole(next.role)) idsToDelete.add(String(next.id));
    }

    const ids = Array.from(idsToDelete);

    // (중요) 삭제 지점 이후의 장기기억은 턴 번호가 당겨지면서 전부 무효가 된다.
    // 그래서 "전체 삭제" 대신, **삭제된 assistant 턴이 포함된 윈도우부터 끝까지**를 잘라내고
    // 그 이전(안전 구간)만 유지한다.
    let affectedTurn = 0;
    for (const id of ids) {
      const j = ordered.findIndex((r) => String(r.id) === String(id));
      if (j < 0) continue;
      const r = String(ordered[j]?.role || "");
      if (!isAssistantLikeRole(r)) continue;
      const t = countAssistantTurnsUpToIndex(ordered, j);
      if (t > 0 && (!affectedTurn || t < affectedTurn)) affectedTurn = t;
    }
    if (!affectedTurn) {
      // fallback: 삭제 대상에 assistant가 없으면(이론상) 해당 메시지의 영향 지점을 기준으로 자른다.
      affectedTurn = computeAffectedAssistantTurn(ordered, idx);
    }
    const sourceIndex = ordered.findIndex((row) => idsToDelete.has(String(row.id)));

    withCurrentChatHistory(historySnapshot, () => {
      for (const id of ids) {
        db.prepare(`DELETE FROM message_usage WHERE messageId=?`).run(id);
        db.prepare(`DELETE FROM chat_character_events WHERE messageId=?`).run(id);
        db.prepare(`DELETE FROM messages WHERE id=?`).run(id);
      }

      // IMPORTANT: derived caches
      const cid = msg.chatId;
      invalidateDerivedMemory(cid, affectedTurn, sourceIndex,
        affectedTurn || countAssistantTurnsUpToIndex(ordered, idx) + 1);
    });

    return NextResponse.json({ ok: true, deleted: ids });
  } catch (e: any) {
    if (e instanceof StaleChatHistoryError) return jsonError("대화가 변경되어 삭제를 다시 시도해 주세요.", 409);
    return jsonError(e?.message || "error", 500);
  }
}
