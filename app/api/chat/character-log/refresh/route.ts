import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decryptIfPossible } from "@/lib/crypto";
import { requireChatAccess, bad } from "@/app/api/memory/_util";
import { extractCharacterTurnEvents } from "@/app/api/chat/send/_server/characterLog";

function isAssistantLikeRole(role: unknown) {
  const r = String(role || "").toLowerCase();
  return r === "assistant" || r === "model";
}

const SURNAME_CHARS = "김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우";
const ROLE_HINT_NAMES = new Set(["어머니", "아버지", "누나", "형", "코치", "의사", "기사"]);
const HINT_BLOCKLIST = new Set([
  "신입생",
  "운동장",
  "유니폼",
  "정적만",
  "조감도",
  "전방에",
  "없다는",
  "이해도",
  "이번에",
  "배에서",
  "주저앉",
  "차단하",
  "장면들",
  "임원들",
  "신청서",
  "정답이",
  "하이라이",
  "차림의",
  "성준슛",
  "정신력",
  "주전조",
  "이없다",
  "신거리",
]);

function isLikelyHintName(name: string) {
  const n = String(name || "").trim();
  if (!n || n.length !== 3) return false;
  if (!new RegExp(`^[${SURNAME_CHARS}][가-힣]{2}$`).test(n)) return false;
  if (HINT_BLOCKLIST.has(n)) return false;
  return true;
}

function collectKnownNameHints(rows: any[]) {
  const weak = new Map<string, number>();
  const strong = new Map<string, number>();
  const rxWeak = new RegExp(
    `(?:^|[^가-힣])([${SURNAME_CHARS}][가-힣]{2})(?:은|는|이|가|에게|한테|의)(?=$|[^가-힣])`,
    "g"
  );
  const rxStrong = new RegExp(
    `(?:^|[^가-힣])([${SURNAME_CHARS}][가-힣]{2})(?:\\s*(?:형|누나|양|씨|코치|주장|선배)|\\()`,
    "g"
  );
  const bump = (map: Map<string, number>, key: string) => map.set(key, Number(map.get(key) || 0) + 1);

  for (const r of rows) {
    const content = decryptIfPossible(String(r?.content || ""));
    let m: RegExpExecArray | null = null;
    while ((m = rxWeak.exec(content)) !== null) {
      const n = String(m?.[1] || "").trim();
      if (!isLikelyHintName(n)) continue;
      bump(weak, n);
    }
    while ((m = rxStrong.exec(content)) !== null) {
      const n = String(m?.[1] || "").trim();
      if (!isLikelyHintName(n)) continue;
      bump(strong, n);
    }
  }

  const out = new Set<string>();
  for (const [n, c] of weak.entries()) {
    const s = Number(strong.get(n) || 0);
    if (s > 0 || c >= 3) out.add(n);
  }
  for (const [n, s] of strong.entries()) {
    if (s > 0) out.add(n);
  }
  return [...out];
}

function isRollingNameCandidate(name: string) {
  const n = String(name || "").trim();
  if (!n || n === "unknown") return false;
  if (ROLE_HINT_NAMES.has(n)) return true;
  return isLikelyHintName(n);
}

function shouldPersistActor(name: string, personaName: string) {
  const n = String(name || "").trim();
  if (!n || n === "unknown") return false;
  if (personaName && n === personaName) return true;
  if (ROLE_HINT_NAMES.has(n)) return true;
  return isLikelyHintName(n);
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    const chatId = String(body?.chatId || "").trim();
    if (!chatId) return bad("chatId가 필요합니다.");

    const access = await requireChatAccess(chatId);
    if (!access.ok) return access.res;

    const force = Boolean(body?.force);

    const profile = db
      .prepare(
        `SELECT s.personaName AS personaName, p.characterName AS npcName
         FROM chats c
         LEFT JOIN chat_settings s ON s.chatId = c.id
         LEFT JOIN presets p ON p.id = c.presetId
         WHERE c.id=?
         LIMIT 1`
      )
      .get(chatId) as any;

    const personaName = String(profile?.personaName || "").trim();
    const npcName = String(profile?.npcName || "").trim();

    const all = db
      .prepare(`SELECT id, role, content, createdAt FROM messages WHERE chatId=? ORDER BY createdAt ASC, id ASC`)
      .all(chatId) as any[];
    const hintedNames = collectKnownNameHints(all);

    const existingRows = db
      .prepare(`SELECT messageId FROM chat_character_events WHERE chatId=?`)
      .all(chatId) as any[];
    const existing = new Set<string>(existingRows.map((r) => String(r?.messageId || "")).filter(Boolean));
    const beforeCount = force
      ? Number((db.prepare(`SELECT COUNT(1) AS c FROM chat_character_events WHERE chatId=?`).get(chatId) as any)?.c || 0)
      : 0;

    let turnNo = 0;
    let lastUserText = "";
    const rollingKnownNames = new Set<string>();
    if (personaName) rollingKnownNames.add(personaName);
    if (npcName) rollingKnownNames.add(npcName);
    for (const n of hintedNames) {
      if (isRollingNameCandidate(n)) rollingKnownNames.add(n);
    }
    let scannedAssistantMessages = 0;
    let candidateMessages = 0;
    let insertedMessages = 0;
    let insertedEvents = 0;

    const payloads: Array<{
      messageId: string;
      turnNo: number;
      createdAt: number;
      events: ReturnType<typeof extractCharacterTurnEvents>;
    }> = [];

    for (const m of all) {
      const role = String(m?.role || "").toLowerCase();
      const content = decryptIfPossible(String(m?.content || ""));
      if (role === "user") {
        lastUserText = String(content || "").trim();
        continue;
      }
      if (!isAssistantLikeRole(role)) continue;

      scannedAssistantMessages += 1;
      turnNo += 1;
      const messageId = String(m?.id || "").trim();
      if (!messageId) continue;
      if (!force && existing.has(messageId)) continue;

      candidateMessages += 1;
      const extracted = extractCharacterTurnEvents({
        userText: lastUserText,
        assistantText: String(content || ""),
        personaName,
        npcName,
        knownNames: [...rollingKnownNames],
        knownActorOnly: true,
        maxEvents: 24,
      });
      const events = extracted.filter((ev) => shouldPersistActor(String((ev as any)?.actor || ""), personaName));

      if (!events.length) continue;
      for (const ev of events) {
        const a = String((ev as any)?.actor || "").trim();
        const t = String((ev as any)?.target || "").trim();
        if (isRollingNameCandidate(a)) rollingKnownNames.add(a);
        if (isRollingNameCandidate(t)) rollingKnownNames.add(t);
      }
      payloads.push({
        messageId,
        turnNo,
        createdAt: Math.max(0, Math.floor(Number(m?.createdAt || Date.now()))),
        events,
      });
    }

    const tx = db.transaction((items: typeof payloads) => {
      if (force) {
        db.prepare(`DELETE FROM chat_character_events WHERE chatId=?`).run(chatId);
      }
      const del = db.prepare(`DELETE FROM chat_character_events WHERE messageId=?`);
      const ins = db.prepare(
        `INSERT INTO chat_character_events
           (chatId, messageId, turnNo, sourceRole, eventType, actor, target, action, evidence, confidence, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const item of items) {
        if (!force) del.run(item.messageId);
        for (const ev of item.events) {
          ins.run(
            chatId,
            item.messageId,
            item.turnNo,
            String((ev as any)?.sourceRole || "assistant"),
            String((ev as any)?.eventType || "action"),
            String((ev as any)?.actor || "unknown"),
            String((ev as any)?.target || ""),
            String((ev as any)?.action || ""),
            String((ev as any)?.evidence || ""),
            Math.max(0, Math.min(100, Math.floor(Number((ev as any)?.confidence || 0)))),
            item.createdAt,
            item.createdAt
          );
        }
      }
    });
    tx(payloads);

    insertedMessages = payloads.length;
    insertedEvents = payloads.reduce((acc, p) => acc + p.events.length, 0);
    const afterCount = Number((db.prepare(`SELECT COUNT(1) AS c FROM chat_character_events WHERE chatId=?`).get(chatId) as any)?.c || 0);

    try {
      console.info(
        `[character-log.refresh] chatId=${chatId} force=${force} scanned=${scannedAssistantMessages} candidate=${candidateMessages} insertedMessages=${insertedMessages} insertedEvents=${insertedEvents} before=${beforeCount} after=${afterCount}`
      );
    } catch {
      // ignore
    }

    return NextResponse.json({
      ok: true,
      chatId,
      scannedAssistantMessages,
      candidateMessages,
      insertedMessages,
      insertedEvents,
      beforeCount,
      afterCount,
      force,
    });
  } catch (e: any) {
    return bad(e?.message || "character_log_refresh_failed", 500);
  }
}
