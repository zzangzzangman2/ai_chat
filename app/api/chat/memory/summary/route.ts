import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { requireChatAccess, bad } from "@/app/api/memory/_util";
import { stripUrlsAndMediaMarkdown } from "@/lib/memory_sanitize";
import {
  normalizeStoredMemorySummary,
  strlenSummary,
  getSummarizedEndTurn,
} from "@/app/api/chat/send/_server/summaryStored";
import { sanitizeLongMemorySummary, normalizeSummaryTail } from "@/app/api/chat/send/_server/memory";

export const runtime = "nodejs";

const BASE_POLICY = {
  mode: "B" as const,
  summaryEvery: 3,
  keepUserTurns: 7,
};

// NOTE: keep 160 supported (some UIs used it historically).
const PER_TURN_OPTIONS = [80, 140, 160, 200, 260, 320] as const;
type PerTurnChars = (typeof PER_TURN_OPTIONS)[number];


function normalizePerTurnChars(v: any): PerTurnChars {
  const n = Number(v);
  if (!Number.isFinite(n)) return 80;
  if (PER_TURN_OPTIONS.includes(n as PerTurnChars)) return n as PerTurnChars;
  // closest match
  let best: PerTurnChars = PER_TURN_OPTIONS[0];
  for (const opt of PER_TURN_OPTIONS) {
    if (Math.abs(opt - n) < Math.abs(best - n)) best = opt;
  }
  return best;
}

function getPolicy(chatId: string) {
  const st = db
    .prepare(`SELECT longMemoryPerTurnChars FROM chat_settings WHERE chatId=?`)
    .get(chatId) as any;
  const perTurnChars = normalizePerTurnChars(st?.longMemoryPerTurnChars ?? 80);
  return { ...BASE_POLICY, perTurnChars };
}

function upsertPerTurnChars(chatId: string, perTurnChars: number, now: number) {
  // ensure row exists
  db.prepare(
    `INSERT INTO chat_settings (chatId, updatedAt)
     VALUES (?, ?)
     ON CONFLICT(chatId) DO UPDATE SET updatedAt=excluded.updatedAt`
  ).run(chatId, now);

  db.prepare(
    `UPDATE chat_settings SET longMemoryPerTurnChars=?, updatedAt=? WHERE chatId=?`
  ).run(perTurnChars, now, chatId);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const chatId = (url.searchParams.get("chatId") || "").trim();
    if (!chatId) return bad("chatId가 필요합니다.");

    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const row = db
      .prepare(
        `SELECT recentSummary, summarizedEndTurn, rolledUpCount, lastSummarizedAt, updatedAt, recentSummaryChars
         FROM chat_memory_cache WHERE chatId=?`
      )
      .get(chatId) as any;

    const summary = decryptIfPossible(String(row?.recentSummary || ""));
    const meta = {
      summarizedEndTurn: Number(row?.summarizedEndTurn || 0),
      rolledUpCount: Number(row?.rolledUpCount || 0),
      lastSummarizedAt: Number(row?.lastSummarizedAt || 0),
      updatedAt: Number(row?.updatedAt || 0),
      recentSummaryChars: Number(row?.recentSummaryChars || 0),
    };

    const policy = getPolicy(chatId);
    return NextResponse.json({ ok: true, chatId, summary, meta, policy });
  } catch (e: any) {
    console.error("/api/chat/memory/summary error", e);
    return bad(e?.message || "summary_failed", 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const chatId = String(body?.chatId || "").trim();
    if (!chatId) return bad("chatId가 필요합니다.");

    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const now = Date.now();

    // (1) policy update (optional)
    let policy = getPolicy(chatId);
    if (Object.prototype.hasOwnProperty.call(body, "perTurnChars")) {
      const nextPer = normalizePerTurnChars(body?.perTurnChars);
      upsertPerTurnChars(chatId, nextPer, now);
      policy = { ...BASE_POLICY, perTurnChars: nextPer };
    }

    // (2) summary update (optional)
    const hasSummary = Object.prototype.hasOwnProperty.call(body, "summary");
    if (!hasSummary) {
      // policy-only save
      const row = db
        .prepare(
          `SELECT recentSummary, summarizedEndTurn, rolledUpCount, lastSummarizedAt, updatedAt, recentSummaryChars
           FROM chat_memory_cache WHERE chatId=?`
        )
        .get(chatId) as any;

      const summary = decryptIfPossible(String(row?.recentSummary || ""));
      const meta = {
        summarizedEndTurn: Number(row?.summarizedEndTurn || 0),
        rolledUpCount: Number(row?.rolledUpCount || 0),
        lastSummarizedAt: Number(row?.lastSummarizedAt || 0),
        updatedAt: Number(row?.updatedAt || 0),
        recentSummaryChars: Number(row?.recentSummaryChars || 0),
      };

      return NextResponse.json({ ok: true, chatId, summary, meta, policy });
    }

    const incoming = String(body?.summary || "");

    // (B-mode) 요약.txt는 사용자가 직접 편집할 수 있으므로
    // URL/이미지 마크다운 등만 제거하고, 헤더는 유지한다.
    let next = stripUrlsAndMediaMarkdown(incoming, { keepHeadings: true });
    next = normalizeSummaryTail(next);
    next = normalizeStoredMemorySummary(next, policy.summaryEvery);
    next = sanitizeLongMemorySummary(normalizeSummaryTail(next), policy.summaryEvery);

    const nextEndTurn = Math.max(0, getSummarizedEndTurn(next));
    const recentSummaryChars = strlenSummary(next);

    // rolledUpCount는 유지
    const row = db
      .prepare(`SELECT rolledUpCount FROM chat_memory_cache WHERE chatId=?`)
      .get(chatId) as any;
    const rolledUpCount = Math.max(0, Number(row?.rolledUpCount || 0));

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
    ).run(chatId, encryptIfPossible(next), nextEndTurn, rolledUpCount, now, now, recentSummaryChars);

    return NextResponse.json({
      ok: true,
      chatId,
      summary: next,
      meta: {
        summarizedEndTurn: nextEndTurn,
        rolledUpCount,
        lastSummarizedAt: now,
        updatedAt: now,
        recentSummaryChars,
      },
      policy,
    });
  } catch (e: any) {
    console.error("/api/chat/memory/summary POST error", e);
    return bad(e?.message || "save_failed", 500);
  }
}
