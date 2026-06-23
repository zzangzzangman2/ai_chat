import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";
import { decryptIfPossible } from "@/lib/crypto";

type HistoryRow = {
  id: string;
  chatId: string;
  role: string;
  content: string;
  createdAt: number;
  usageModel?: string | null;
  promptTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  latencyMs?: number | null;
  estPromptTotal?: number | null;
  tokenBreakdown?: string | null;
  finishReason?: string | null;
  maxOutputTokensRequested?: number | null;
  maxOutputTokensForProvider?: number | null;
  effectiveMaxOutputTokens?: number | null;
  reasoningHeadroomTokens?: number | null;
  thinkingBudget?: number | null;
  thinkingLevel?: string | null;
  usageMetaJson?: string | null;
  costUsd?: number | null;
  costKrw?: number | null;
  usdToKrw?: number | null;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chatId = searchParams.get("chatId") || "";
  const beforeRaw = searchParams.get("before"); // createdAt(ms) exclusive
  const afterRaw = searchParams.get("after"); // createdAt(ms) exclusive (load newer)
  const limitRaw = searchParams.get("limit");
  const messageId = searchParams.get("messageId"); // optional: fetch single message (usage hydrate)
  const includeUsageRaw = String(searchParams.get("includeUsage") || "").trim().toLowerCase();
  const includeUsage = includeUsageRaw === "1" || includeUsageRaw === "true" || includeUsageRaw === "full";

  if (!chatId) {
    return NextResponse.json({ error: "chatId가 필요합니다." }, { status: 400 });
  }

  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const isConfiguredAdmin = isAdminEmail(u.email);
  const roleRow = isConfiguredAdmin ? null : (db.prepare(`SELECT role FROM users WHERE email=?`).get(u.email) as any);
  const canViewDeveloper = isConfiguredAdmin || String(roleRow?.role || "").toLowerCase() === "admin";

  const chat = db.prepare(`SELECT id FROM chats WHERE id=? AND userEmail=?`).get(chatId, u.email);
  if (!chat) {
    return NextResponse.json({ error: "채팅을 찾지 못했습니다." }, { status: 404 });
  }

  // --------
  // 1) Single message (usage hydrate) - keeps network light even for huge chats
  // --------
  if (messageId) {
    const row = db
      .prepare(
        `SELECT m.id, m.chatId, m.role, m.content, m.createdAt,
                u.model as usageModel, u.promptTokens, u.outputTokens, u.reasoningTokens, u.totalTokens, u.latencyMs,
                u.estPromptTotal, u.tokenBreakdown, u.finishReason,
                u.maxOutputTokensRequested, u.maxOutputTokensForProvider, u.effectiveMaxOutputTokens,
                u.reasoningHeadroomTokens, u.thinkingBudget, u.thinkingLevel, u.usageMetaJson,
                u.costUsd, u.costKrw, u.usdToKrw
           FROM messages m
           LEFT JOIN message_usage u ON u.messageId = m.id
          WHERE m.chatId=? AND m.id=?
          LIMIT 1`
      )
      .get(chatId, messageId);

    if (!row) return NextResponse.json({ messages: [] });

    const m = row as HistoryRow;
    const msg = {
      ...m,
      content: decryptIfPossible(String(m.content || "")),
      usage: m.usageModel
        ? {
            model: String(m.usageModel || ""),
            promptTokens: Number(m.promptTokens || 0),
            outputTokens: Number(m.outputTokens || 0),
            reasoningTokens: Number(m.reasoningTokens || 0),
            totalTokens: Number(m.totalTokens || 0),
            latencyMs: Number(m.latencyMs || 0),
            finishReason: String(m.finishReason || ""),
            ...(canViewDeveloper ? { estPromptTotal: Number(m.estPromptTotal || 0) } : {}),
            ...(canViewDeveloper
              ? {
                  maxOutputTokensRequested: Number(m.maxOutputTokensRequested || 0),
                  maxOutputTokensForProvider: Number(m.maxOutputTokensForProvider || 0),
                  effectiveMaxOutputTokens: Number(m.effectiveMaxOutputTokens || 0),
                  reasoningHeadroomTokens: Number(m.reasoningHeadroomTokens || 0),
                  thinkingBudget: Number(m.thinkingBudget || 0),
                  thinkingLevel: String(m.thinkingLevel || ""),
                }
              : {}),
            estimatedCostUsd: Number(m.costUsd || 0),
            estimatedCostKrw: Number(m.costKrw || 0),
            usdToKrw: Number(m.usdToKrw || 0),
            ...(canViewDeveloper
              ? {
                  tokenBreakdown: (() => {
                    try {
                      return m.tokenBreakdown ? JSON.parse(String(m.tokenBreakdown)) : {};
                    } catch {
                      return {};
                    }
                  })(),
                }
              : {}),
          }
        : null,
    };

    return NextResponse.json({ messages: [msg] });
  }

  // --------
  // 2) Paged history (infinite scroll up)
  // - default: latest page
  // - before: load older than given createdAt(ms)
  // - after : load newer than given createdAt(ms)
  // --------
  const limit = Math.max(20, Math.min(400, Number(limitRaw || 200) || 200));
  const before = beforeRaw != null && beforeRaw !== "" ? Number(beforeRaw) : null;
  const after = afterRaw != null && afterRaw !== "" ? Number(afterRaw) : null;
  const pageSizePlusOne = limit + 1;
  const usageSelect = includeUsage
    ? `u.model as usageModel, u.promptTokens, u.outputTokens, u.reasoningTokens, u.totalTokens, u.latencyMs,
       u.estPromptTotal, u.tokenBreakdown, u.finishReason,
       u.maxOutputTokensRequested, u.maxOutputTokensForProvider, u.effectiveMaxOutputTokens,
       u.reasoningHeadroomTokens, u.thinkingBudget, u.thinkingLevel, u.usageMetaJson,
       u.costUsd, u.costKrw, u.usdToKrw`
    : `u.model as usageModel, u.totalTokens`;

  const rows = (
    after != null && Number.isFinite(after)
      ? db
          .prepare(
            `SELECT m.id, m.chatId, m.role, m.content, m.createdAt,
                    ${usageSelect}
               FROM messages m
               LEFT JOIN message_usage u ON u.messageId = m.id
              WHERE m.chatId=? AND m.createdAt > ?
              ORDER BY m.createdAt ASC
              LIMIT ?`
          )
          .all(chatId, after, pageSizePlusOne)
      : before != null && Number.isFinite(before)
        ? db
            .prepare(
              `SELECT m.id, m.chatId, m.role, m.content, m.createdAt,
                      ${usageSelect}
                 FROM messages m
                 LEFT JOIN message_usage u ON u.messageId = m.id
                WHERE m.chatId=? AND m.createdAt < ?
                ORDER BY m.createdAt DESC
                LIMIT ?`
            )
            .all(chatId, before, pageSizePlusOne)
        : db
            .prepare(
              `SELECT m.id, m.chatId, m.role, m.content, m.createdAt,
                      ${usageSelect}
                 FROM messages m
                 LEFT JOIN message_usage u ON u.messageId = m.id
                WHERE m.chatId=?
                ORDER BY m.createdAt DESC
                LIMIT ?`
            )
            .all(chatId, pageSizePlusOne)
  ) as HistoryRow[];

    const hasMoreNewer = after != null && Number.isFinite(after) ? rows.length > limit : false;
  const hasMoreOlder = !(after != null && Number.isFinite(after)) ? rows.length > limit : false;
  const sliced = rows.slice(0, limit);
  const ordered = after != null && Number.isFinite(after) ? sliced : sliced.reverse(); // ASC for UI

  const messages = ordered.map((m) => {
    const base = {
      id: m.id,
      chatId: m.chatId,
      role: m.role,
      content: decryptIfPossible(String(m.content || "")),
      createdAt: Number(m.createdAt || 0),
    };

    if (!m.usageModel) return base;
    if (!includeUsage) {
      return {
        ...base,
        usage: {
          model: String(m.usageModel || ""),
          totalTokens: Number(m.totalTokens || 0),
        },
      };
    }

    return {
      ...base,
      usage: {
        model: String(m.usageModel || ""),
        promptTokens: Number(m.promptTokens || 0),
        outputTokens: Number(m.outputTokens || 0),
        reasoningTokens: Number(m.reasoningTokens || 0),
        totalTokens: Number(m.totalTokens || 0),
        latencyMs: Number(m.latencyMs || 0),
        finishReason: String(m.finishReason || ""),
        ...(canViewDeveloper ? { estPromptTotal: Number(m.estPromptTotal || 0) } : {}),
        ...(canViewDeveloper
          ? {
              maxOutputTokensRequested: Number(m.maxOutputTokensRequested || 0),
              maxOutputTokensForProvider: Number(m.maxOutputTokensForProvider || 0),
              effectiveMaxOutputTokens: Number(m.effectiveMaxOutputTokens || 0),
              reasoningHeadroomTokens: Number(m.reasoningHeadroomTokens || 0),
              thinkingBudget: Number(m.thinkingBudget || 0),
              thinkingLevel: String(m.thinkingLevel || ""),
            }
          : {}),
        estimatedCostUsd: Number(m.costUsd || 0),
        estimatedCostKrw: Number(m.costKrw || 0),
        usdToKrw: Number(m.usdToKrw || 0),
        ...(canViewDeveloper
          ? {
              tokenBreakdown: (() => {
                try {
                  return m.tokenBreakdown ? JSON.parse(String(m.tokenBreakdown)) : {};
                } catch {
                  return {};
                }
              })(),
            }
          : {}),
      },
    };
  });

  return NextResponse.json({ messages, hasMoreOlder, hasMoreNewer });
}
