import { NextResponse } from "next/server";

import { bad, requireChatAccess } from "@/app/api/memory/_util";
import { decryptIfPossible } from "@/lib/crypto";
import { db } from "@/lib/db";
import {
  deriveIdentityCanon,
  inferPersonaNameFromMessages,
} from "@/lib/identity_memory";
import { syncCharacterVitals } from "@/lib/character_vitals";
import {
  ensureCharacterAffinityRows,
  loadRelationshipGraph,
  syncIdentityCanonRelations,
} from "@/lib/relationship_graph";

export const runtime = "nodejs";

function cleanText(value: unknown, max = 120) {
  return String(value ?? "").trim().slice(0, max);
}

function loadMessages(chatId: string) {
  return (
    db
      .prepare(
        `SELECT role, content, createdAt
         FROM messages
         WHERE chatId=?
         ORDER BY createdAt ASC, id ASC`
      )
      .all(chatId) as any[]
  ).map((row) => ({
    role: String(row?.role || ""),
    content: decryptIfPossible(String(row?.content || "")),
    createdAt: Number(row?.createdAt || 0),
  }));
}

function loadRoster(chatId: string) {
  return db
    .prepare(
      `SELECT id, name
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0
       ORDER BY updatedAt DESC, name ASC`
    )
    .all(chatId) as Array<{ id: string; name: string }>;
}

function graphResponse(chatId: string, personaFallback = "") {
  const graph = loadRelationshipGraph(chatId);
  return {
    ...graph,
    personaName: graph.personaName || personaFallback,
  };
}

export async function GET(req: Request) {
  try {
    const chatId = cleanText(new URL(req.url).searchParams.get("chatId"));
    if (!chatId) return bad("chatId가 필요합니다.");
    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;
    const settings = db
      .prepare(`SELECT personaName, personaAge FROM chat_settings WHERE chatId=?`)
      .get(chatId) as any;
    return NextResponse.json({
      ok: true,
      chatId,
      ...graphResponse(chatId, cleanText(settings?.personaName, 80)),
    });
  } catch (error: any) {
    console.error("/api/chat/relationships GET error", error);
    return bad(error?.message || "relationship_graph_failed", 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const chatId = cleanText(body?.chatId);
    if (!chatId) return bad("chatId가 필요합니다.");
    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const messages = loadMessages(chatId);
    const roster = loadRoster(chatId);
    const settings = db
      .prepare(`SELECT personaName, personaAge FROM chat_settings WHERE chatId=?`)
      .get(chatId) as any;
    const configuredPersonaName = cleanText(settings?.personaName, 80);
    const personaName =
      configuredPersonaName ||
      inferPersonaNameFromMessages(messages);
    const canon = deriveIdentityCanon({
      messages,
      knownNames: roster.map((row) => String(row?.name || "")),
      personaName,
    });
    const turnNo = messages.filter((message) =>
      ["assistant", "model"].includes(String(message.role || "").toLowerCase())
    ).length;
    const synced = syncIdentityCanonRelations({ chatId, canon, turnNo });
    syncCharacterVitals({
      chatId,
      messages,
      canon,
      personaName: canon.personaName,
      personaAge: Number(settings?.personaAge || 0),
    });
    ensureCharacterAffinityRows({ chatId, personaName: canon.personaName, characters: roster });

    return NextResponse.json({
      ok: true,
      chatId,
      synced,
      ...graphResponse(chatId, canon.personaName),
    });
  } catch (error: any) {
    console.error("/api/chat/relationships POST error", error);
    return bad(error?.message || "relationship_graph_refresh_failed", 500);
  }
}
