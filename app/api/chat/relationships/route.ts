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
  clearManualRelationship,
  ensureCharacterAffinityRows,
  loadRelationshipGraph,
  setManualRelationship,
  syncIdentityCanonRelations,
} from "@/lib/relationship_graph";
import { isInvalidRelationshipLabel } from "@/lib/relationship_context";

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
  const rows = db
    .prepare(
      `SELECT id, name, role, profile, relationshipNote, emotionNote, status
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0
       ORDER BY updatedAt DESC, name ASC`
    )
    .all(chatId) as any[];
  return rows.map((row) => ({
    id: String(row?.id || ""),
    name: String(row?.name || ""),
    role: decryptIfPossible(String(row?.role || "")),
    profile: decryptIfPossible(String(row?.profile || "")),
    relationshipNote: decryptIfPossible(String(row?.relationshipNote || "")),
    emotionNote: decryptIfPossible(String(row?.emotionNote || "")),
    status: decryptIfPossible(String(row?.status || "")),
  }));
}

function graphResponse(chatId: string, personaFallback = "") {
  const graph = loadRelationshipGraph(chatId);
  return {
    ...graph,
    personaName: graph.personaName || personaFallback,
  };
}

function relationshipPersonaName(chatId: string) {
  const settings = db
    .prepare(`SELECT personaName FROM chat_settings WHERE chatId=?`)
    .get(chatId) as { personaName?: unknown } | undefined;
  return cleanText(settings?.personaName, 80) || inferPersonaNameFromMessages(loadMessages(chatId));
}

function resolveRelationshipPerson(chatId: string, personaName: string, nameRaw: unknown) {
  const name = cleanText(nameRaw, 80);
  if (!name) return "";
  if (
    personaName &&
    name.toLocaleLowerCase("ko-KR") === personaName.toLocaleLowerCase("ko-KR")
  ) {
    return personaName;
  }
  const roster = db
    .prepare(
      `SELECT name
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0 AND name=?
       LIMIT 1`
    )
    .get(chatId, name) as { name?: unknown } | undefined;
  return cleanText(roster?.name, 80);
}

function relationshipTurnNo(chatId: string) {
  return Number(
    (
      db.prepare(
        `SELECT COUNT(*) AS cnt
         FROM messages
         WHERE chatId=? AND LOWER(role) IN ('assistant', 'model')`
      ).get(chatId) as { cnt?: unknown } | undefined
    )?.cnt || 0
  );
}

function relationshipPeople(chatId: string, personaName: string, body: any) {
  const subjectName = resolveRelationshipPerson(chatId, personaName, body?.subjectName);
  const objectName = resolveRelationshipPerson(chatId, personaName, body?.objectName);
  return { subjectName, objectName };
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
    if (!configuredPersonaName && personaName) {
      db.prepare(
        `UPDATE chat_settings SET personaName=?, updatedAt=? WHERE chatId=?`
      ).run(personaName, Date.now(), chatId);
    }
    const canon = deriveIdentityCanon({
      messages,
      knownNames: roster.map((row) => String(row?.name || "")),
      personaName,
      characterSources: roster,
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

export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const chatId = cleanText(body?.chatId);
    if (!chatId) return bad("chatId가 필요합니다.");
    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const personaName = relationshipPersonaName(chatId);
    const { subjectName, objectName } = relationshipPeople(chatId, personaName, body);
    const relation = cleanText(body?.relation, 40);
    const details = cleanText(body?.details, 500);
    if (!subjectName || !objectName || subjectName === objectName) {
      return bad("서로 다른 두 인물을 선택해 주세요.");
    }
    if (!relation || isInvalidRelationshipLabel(relation)) {
      return bad("관계를 정확히 입력해 주세요. 감정이나 미확인 문구는 관계로 저장할 수 없습니다.");
    }

    setManualRelationship({
      chatId,
      personaName,
      subjectName,
      objectName,
      relation,
      details,
      turnNo: relationshipTurnNo(chatId),
    });
    return NextResponse.json({
      ok: true,
      chatId,
      mode: "manual",
      ...graphResponse(chatId, personaName),
    });
  } catch (error: any) {
    console.error("/api/chat/relationships PUT error", error);
    return bad(error?.message || "relationship_update_failed", 500);
  }
}

export async function DELETE(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const chatId = cleanText(body?.chatId);
    if (!chatId) return bad("chatId가 필요합니다.");
    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const personaName = relationshipPersonaName(chatId);
    const { subjectName, objectName } = relationshipPeople(chatId, personaName, body);
    if (!subjectName || !objectName || subjectName === objectName) {
      return bad("서로 다른 두 인물을 선택해 주세요.");
    }
    const removed = clearManualRelationship({
      chatId,
      personaName,
      subjectName,
      objectName,
    });
    return NextResponse.json({
      ok: true,
      chatId,
      mode: "automatic",
      removed,
      ...graphResponse(chatId, personaName),
    });
  } catch (error: any) {
    console.error("/api/chat/relationships DELETE error", error);
    return bad(error?.message || "relationship_reset_failed", 500);
  }
}
