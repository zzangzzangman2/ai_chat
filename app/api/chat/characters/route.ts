import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { bad, requireChatAccess } from "@/app/api/memory/_util";
import { inferCharacterOccupation } from "@/lib/relationship_context";

function cleanText(v: unknown, max = 4000) {
  return String(v ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u001f]/g, (ch) => (ch === "\n" || ch === "\t" ? ch : ""))
    .trim()
    .slice(0, max);
}

function hasBatchim(s: string) {
  const ch = String(s || "").trim().slice(-1);
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

function withParticle(name: string, pair: "은는" | "이가" | "을를" | "과와") {
  const n = String(name || "").trim();
  if (!n) return "";
  const batchim = hasBatchim(n);
  if (pair === "은는") return n + (batchim ? "은" : "는");
  if (pair === "이가") return n + (batchim ? "이" : "가");
  if (pair === "을를") return n + (batchim ? "을" : "를");
  return n + (batchim ? "과" : "와");
}

function replaceGenericPersonaRefs(text: string, personaName: string) {
  const name = String(personaName || "").trim();
  let out = String(text || "");
  if (!name) return out;
  for (const ref of ["사용자", "주인공", "플레이어"]) {
    out = out
      .replace(new RegExp(`${ref}와`, "g"), withParticle(name, "과와"))
      .replace(new RegExp(`${ref}과`, "g"), withParticle(name, "과와"))
      .replace(new RegExp(`${ref}는`, "g"), withParticle(name, "은는"))
      .replace(new RegExp(`${ref}은`, "g"), withParticle(name, "은는"))
      .replace(new RegExp(`${ref}가`, "g"), withParticle(name, "이가"))
      .replace(new RegExp(`${ref}이`, "g"), withParticle(name, "이가"))
      .replace(new RegExp(`${ref}를`, "g"), withParticle(name, "을를"))
      .replace(new RegExp(`${ref}을`, "g"), withParticle(name, "을를"))
      .replace(new RegExp(`${ref}에게`, "g"), `${name}에게`)
      .replace(new RegExp(`${ref}한테`, "g"), `${name}한테`)
      .replace(new RegExp(`${ref}로부터`, "g"), `${name}로부터`)
      .replace(new RegExp(`${ref}의`, "g"), `${name}의`)
      .replace(new RegExp(ref, "g"), name);
  }
  return out;
}

function getPersonaName(chatId: string) {
  const row = db.prepare(`SELECT personaName FROM chat_settings WHERE chatId=?`).get(chatId) as any;
  return cleanText(row?.personaName, 80) || "나";
}

function memoryRowForClient(row: any, personaName = "") {
  return {
    turnNo: Number(row?.turnNo || 0),
    summary: replaceGenericPersonaRefs(decryptIfPossible(String(row?.summary || "")), personaName),
    evidence: replaceGenericPersonaRefs(decryptIfPossible(String(row?.evidence || "")), personaName),
    updatedAt: Number(row?.updatedAt || 0),
  };
}

function intParam(v: string | null, fallback: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function rowForClient(row: any, memories: any[] = [], memoryCount = memories.length, personaName = "") {
  const role = decryptIfPossible(String(row?.role || ""));
  const profile = decryptIfPossible(String(row?.profile || ""));
  return {
    id: String(row?.id || ""),
    chatId: String(row?.chatId || ""),
    name: String(row?.name || ""),
    aliases: decryptIfPossible(String(row?.aliases || "")),
    job: inferCharacterOccupation(role, profile),
    role,
    profile,
    relationshipNote: decryptIfPossible(String(row?.relationshipNote || "")),
    emotionNote: decryptIfPossible(String(row?.emotionNote || "")),
    status: decryptIfPossible(String(row?.status || "")),
    enabled: Number(row?.enabled ?? 1) !== 0,
    createdAt: Number(row?.createdAt || 0),
    updatedAt: Number(row?.updatedAt || 0),
    memoryCount: Number(memoryCount || 0),
    memories: memories.map((memory) => memoryRowForClient(memory, personaName)),
  };
}

async function requireRosterAccessById(id: string) {
  const row = db
    .prepare(
      `SELECT r.*, c.userEmail
       FROM chat_character_roster r
       JOIN chats c ON c.id=r.chatId
       WHERE r.id=?`
    )
    .get(id) as any;
  if (!row) return { ok: false as const, res: bad("character not found", 404) };

  const access = await requireChatAccess(String(row.chatId || ""));
  if (!access.ok) return access;
  return { ok: true as const, row };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chatId = String(searchParams.get("chatId") || "").trim();
  const access = await requireChatAccess(chatId);
  if (!access.ok) return access.res;
  const personaName = getPersonaName(chatId);

  const rosterId = String(searchParams.get("rosterId") || "").trim();
  if (rosterId) {
    const roster = db.prepare(`SELECT * FROM chat_character_roster WHERE chatId=? AND id=?`).get(chatId, rosterId) as any;
    if (!roster) return bad("character not found", 404);

    const limit = intParam(searchParams.get("limit"), 5, 1, 20);
    const offset = intParam(searchParams.get("offset"), 0, 0, 1000000);
    const total = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS cnt FROM chat_character_turn_memories WHERE chatId=? AND rosterId=?`)
          .get(chatId, rosterId) as any
      )?.cnt || 0
    );
    const rows = db
      .prepare(
        `SELECT rosterId, turnNo, summary, evidence, updatedAt
         FROM chat_character_turn_memories
         WHERE chatId=? AND rosterId=?
         ORDER BY turnNo ASC
         LIMIT ? OFFSET ?`
      )
      .all(chatId, rosterId, limit, offset) as any[];

    return NextResponse.json({
      ok: true,
      character: rowForClient(roster, [], total, personaName),
      rosterId,
      total,
      offset,
      limit,
      nextOffset: offset + rows.length,
      hasMore: offset + rows.length < total,
      memories: rows.map((row) => memoryRowForClient(row, personaName)),
    });
  }

  const includeMemories = searchParams.get("includeMemories") !== "0";
  const rows = db
    .prepare(
      `SELECT *
       FROM chat_character_roster
       WHERE chatId=? AND name <> ?
       ORDER BY enabled DESC, updatedAt DESC, name ASC`
    )
    .all(chatId, personaName) as any[];

  const counts = db
    .prepare(
      `SELECT rosterId, COUNT(*) AS cnt
       FROM chat_character_turn_memories
       WHERE chatId=?
       GROUP BY rosterId`
    )
    .all(chatId) as any[];
  const countByRoster = new Map<string, number>();
  for (const row of counts) countByRoster.set(String((row as any)?.rosterId || ""), Number((row as any)?.cnt || 0));

  if (!includeMemories) {
    return NextResponse.json({
      ok: true,
      characters: rows.map((row) => rowForClient(row, [], countByRoster.get(String(row?.id || "")) || 0, personaName)),
    });
  }

  const memories = db
    .prepare(
      `SELECT rosterId, turnNo, summary, evidence, updatedAt
       FROM chat_character_turn_memories
       WHERE chatId=?
       ORDER BY turnNo ASC`
    )
    .all(chatId) as any[];
  const byRoster = new Map<string, any[]>();
  for (const memory of memories) {
    const key = String(memory?.rosterId || "");
    if (!byRoster.has(key)) byRoster.set(key, []);
    byRoster.get(key)!.push(memory);
  }

  return NextResponse.json({
    ok: true,
    characters: rows.map((row) =>
      rowForClient(
        row,
        byRoster.get(String(row?.id || "")) || [],
        countByRoster.get(String(row?.id || "")) || 0,
        personaName
      )
    ),
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as any;
  const chatId = String(body?.chatId || "").trim();
  const access = await requireChatAccess(chatId);
  if (!access.ok) return access.res;

  const name = cleanText(body?.name, 80);
  if (!name) return bad("name required");

  const now = Date.now();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO chat_character_roster
       (id, chatId, name, aliases, role, profile, relationshipNote, emotionNote, status, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chatId, name) DO UPDATE SET
       aliases=excluded.aliases,
       role=excluded.role,
       profile=excluded.profile,
       relationshipNote=excluded.relationshipNote,
       emotionNote=excluded.emotionNote,
       status=excluded.status,
       enabled=excluded.enabled,
       updatedAt=excluded.updatedAt`
  ).run(
    id,
    chatId,
    name,
    encryptIfPossible(cleanText(body?.aliases, 1000)),
    encryptIfPossible(cleanText(body?.role, 1000)),
    encryptIfPossible(cleanText(body?.profile, 4000)),
    encryptIfPossible(cleanText(body?.relationshipNote, 4000)),
    encryptIfPossible(cleanText(body?.emotionNote, 4000)),
    encryptIfPossible(cleanText(body?.status, 2000)),
    body?.enabled === false ? 0 : 1,
    now,
    now
  );

  const row = db.prepare(`SELECT * FROM chat_character_roster WHERE chatId=? AND name=?`).get(chatId, name) as any;
  return NextResponse.json({ ok: true, character: rowForClient(row) });
}

export async function PATCH(req: Request) {
  const body = (await req.json().catch(() => null)) as any;
  const id = String(body?.id || "").trim();
  if (!id) return bad("id required");

  const access = await requireRosterAccessById(id);
  if (!access.ok) return access.res;

  const name = cleanText(body?.name ?? access.row.name, 80);
  if (!name) return bad("name required");

  const now = Date.now();
  db.prepare(
    `UPDATE chat_character_roster
     SET name=?, aliases=?, role=?, profile=?, relationshipNote=?, emotionNote=?, status=?, enabled=?, updatedAt=?
     WHERE id=?`
  ).run(
    name,
    encryptIfPossible(cleanText(body?.aliases, 1000)),
    encryptIfPossible(cleanText(body?.role, 1000)),
    encryptIfPossible(cleanText(body?.profile, 4000)),
    encryptIfPossible(cleanText(body?.relationshipNote, 4000)),
    encryptIfPossible(cleanText(body?.emotionNote, 4000)),
    encryptIfPossible(cleanText(body?.status, 2000)),
    body?.enabled === false ? 0 : 1,
    now,
    id
  );

  const row = db.prepare(`SELECT * FROM chat_character_roster WHERE id=?`).get(id) as any;
  return NextResponse.json({ ok: true, character: rowForClient(row) });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = String(searchParams.get("id") || "").trim();
  if (!id) return bad("id required");

  const access = await requireRosterAccessById(id);
  if (!access.ok) return access.res;

  db.prepare(`DELETE FROM chat_character_turn_memories WHERE rosterId=?`).run(id);
  db.prepare(`DELETE FROM chat_character_affinity WHERE rosterId=?`).run(id);
  db.prepare(`DELETE FROM chat_character_vitals WHERE rosterId=?`).run(id);
  db.prepare(`DELETE FROM chat_character_roster WHERE id=?`).run(id);
  return NextResponse.json({ ok: true });
}
