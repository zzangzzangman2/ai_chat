import { randomUUID } from "crypto";

import { db } from "@/lib/db";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import type { IdentityCanon } from "@/lib/identity_memory";
import {
  loadCharacterGraphNodes,
  type CharacterGraphNode,
} from "@/lib/character_vitals";

export type RelationshipGraphRelation = {
  id: string;
  subjectKey: string;
  subjectName: string;
  subjectRosterId: string;
  relation: string;
  slotKey: string;
  objectKey: string;
  objectName: string;
  objectRosterId: string;
  objectRole: string;
  firstSeenTurn: number;
  lastSeenTurn: number;
  updatedAt: number;
};

export type CharacterAffinity = {
  id: string;
  rosterId: string;
  personaName: string;
  characterName: string;
  score: number;
  label: string;
  lastDelta: number;
  reason: string;
  evidence: string;
  lastTurnNo: number;
  updatedAt: number;
};

export type RelationshipGraphData = {
  personaName: string;
  nodes: CharacterGraphNode[];
  relations: RelationshipGraphRelation[];
  affinities: CharacterAffinity[];
};

function cleanText(value: unknown, max = 400) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function stableNameKey(name: string, personaName: string) {
  const value = cleanText(name, 80);
  if (value && value.toLowerCase() === cleanText(personaName, 80).toLowerCase()) {
    return "persona";
  }
  return `name:${value.toLowerCase()}`;
}

function clampInt(value: unknown, min: number, max: number) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

export function affinityLabel(scoreRaw: number) {
  const score = clampInt(scoreRaw, 0, 100);
  if (score >= 85) return "깊은 신뢰";
  if (score >= 70) return "친밀";
  if (score >= 58) return "호의";
  if (score >= 43) return "중립";
  if (score >= 28) return "경계";
  if (score >= 15) return "냉담";
  return "적대";
}

export function syncIdentityCanonRelations(params: {
  chatId: string;
  canon: IdentityCanon;
  turnNo?: number;
}) {
  const chatId = cleanText(params.chatId, 120);
  if (!chatId) return 0;
  const personaName = cleanText(params.canon.personaName, 80);
  const now = Date.now();
  const turnNo = Math.max(0, Math.trunc(Number(params.turnNo || 0)));
  const rows = params.canon.roleAnchors
    .map((anchor) => {
      const subjectName = cleanText(anchor.subjectName, 80);
      const relation = cleanText(anchor.relation, 40);
      const relatedName = cleanText(anchor.relatedName, 80);
      const slotKey = cleanText(anchor.slotKey || "default", 80) || "default";
      if (!subjectName || !relation) return null;
      const subjectKey = stableNameKey(subjectName, personaName);
      const objectKey = relatedName
        ? stableNameKey(relatedName, personaName)
        : `role:${subjectKey}:${relation}:${slotKey}`.toLowerCase();
      return {
        id: randomUUID(),
        chatId,
        subjectKey,
        subjectName,
        relation,
        slotKey,
        objectKey,
        objectName: relatedName,
        objectRole: `${subjectName}의 ${relation}`,
        sourceOrder: Math.max(0, Math.trunc(Number(anchor.sourceOrder || 0))),
      };
    })
    .filter(Boolean) as Array<{
      id: string;
      chatId: string;
      subjectKey: string;
      subjectName: string;
      relation: string;
      slotKey: string;
      objectKey: string;
      objectName: string;
      objectRole: string;
      sourceOrder: number;
    }>;

  const stmt = db.prepare(
    `INSERT INTO chat_character_relations
       (id, chatId, subjectKey, subjectName, relation, slotKey, objectKey, objectName,
        objectRole, sourceOrder, firstSeenTurn, lastSeenTurn, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chatId, subjectKey, relation, slotKey) DO UPDATE SET
       subjectName=excluded.subjectName,
       objectKey=CASE
         WHEN excluded.objectName <> '' THEN excluded.objectKey
         ELSE chat_character_relations.objectKey
       END,
       objectName=CASE
         WHEN excluded.objectName <> '' THEN excluded.objectName
         ELSE chat_character_relations.objectName
       END,
       objectRole=excluded.objectRole,
       sourceOrder=MAX(chat_character_relations.sourceOrder, excluded.sourceOrder),
       firstSeenTurn=CASE
         WHEN chat_character_relations.firstSeenTurn <= 0 THEN excluded.firstSeenTurn
         WHEN excluded.firstSeenTurn <= 0 THEN chat_character_relations.firstSeenTurn
         ELSE MIN(chat_character_relations.firstSeenTurn, excluded.firstSeenTurn)
       END,
       lastSeenTurn=MAX(chat_character_relations.lastSeenTurn, excluded.lastSeenTurn),
       updatedAt=excluded.updatedAt`
  );
  const write = db.transaction(() => {
    const currentKeys = new Set(
      rows.map((row) => `${row.subjectKey}\u0000${row.relation}\u0000${row.slotKey}`)
    );
    const existing = db
      .prepare(`SELECT id, subjectKey, relation, slotKey FROM chat_character_relations WHERE chatId=?`)
      .all(chatId) as Array<{ id: string; subjectKey: string; relation: string; slotKey: string }>;
    const deleteStmt = db.prepare(`DELETE FROM chat_character_relations WHERE id=? AND chatId=?`);
    for (const row of rows) {
      stmt.run(
        row.id,
        row.chatId,
        row.subjectKey,
        row.subjectName,
        row.relation,
        row.slotKey,
        row.objectKey,
        row.objectName,
        row.objectRole,
        row.sourceOrder,
        turnNo,
        turnNo,
        now,
        now
      );
    }
    for (const row of existing) {
      const key = `${String(row.subjectKey || "")}\u0000${String(row.relation || "")}\u0000${String(
        row.slotKey || ""
      )}`;
      if (!currentKeys.has(key)) {
        deleteStmt.run(String(row.id || ""), chatId);
      }
    }
  });
  write();
  return rows.length;
}

export function ensureCharacterAffinityRows(params: {
  chatId: string;
  personaName: string;
  characters: Array<{ id: string; name: string }>;
}) {
  const chatId = cleanText(params.chatId, 120);
  const personaName = cleanText(params.personaName, 80);
  if (!chatId) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO chat_character_affinity
       (id, chatId, rosterId, personaName, characterName, score, lastDelta,
        reason, evidence, lastTurnNo, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 50, 0, '', '', 0, ?, ?)
     ON CONFLICT(chatId, rosterId) DO UPDATE SET
       personaName=excluded.personaName,
       characterName=excluded.characterName,
       updatedAt=CASE
         WHEN chat_character_affinity.personaName <> excluded.personaName
           OR chat_character_affinity.characterName <> excluded.characterName
         THEN excluded.updatedAt
         ELSE chat_character_affinity.updatedAt
       END`
  );
  const write = db.transaction(() => {
    for (const character of params.characters) {
      const rosterId = cleanText(character.id, 120);
      const characterName = cleanText(character.name, 80);
      if (!rosterId || !characterName || characterName === personaName) continue;
      stmt.run(randomUUID(), chatId, rosterId, personaName, characterName, now, now);
    }
  });
  write();
}

export function resetCharacterAffinitiesForTurn(chatIdRaw: string, turnNoRaw: number) {
  const chatId = cleanText(chatIdRaw, 120);
  const turnNo = Math.max(0, Math.trunc(Number(turnNoRaw || 0)));
  if (!chatId || turnNo <= 0) return 0;
  const rows = db
    .prepare(
      `SELECT rosterId, score, lastDelta
       FROM chat_character_affinity
       WHERE chatId=? AND lastTurnNo=?`
    )
    .all(chatId, turnNo) as any[];
  if (!rows.length) return 0;
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE chat_character_affinity
     SET score=?, lastDelta=0, reason='', evidence='', updatedAt=?
     WHERE chatId=? AND rosterId=? AND lastTurnNo=?`
  );
  const write = db.transaction(() => {
    for (const row of rows) {
      const score = clampInt(
        Number(row?.score ?? 50) - Number(row?.lastDelta ?? 0),
        0,
        100
      );
      stmt.run(
        score,
        now,
        chatId,
        cleanText(row?.rosterId, 120),
        turnNo
      );
    }
  });
  write();
  return rows.length;
}

export function updateCharacterAffinity(params: {
  chatId: string;
  rosterId: string;
  personaName: string;
  characterName: string;
  turnNo: number;
  delta: number;
  reason?: string;
  evidence?: string;
}) {
  const chatId = cleanText(params.chatId, 120);
  const rosterId = cleanText(params.rosterId, 120);
  const personaName = cleanText(params.personaName, 80);
  const characterName = cleanText(params.characterName, 80);
  const turnNo = Math.max(0, Math.trunc(Number(params.turnNo || 0)));
  const delta = clampInt(params.delta, -3, 3);
  if (!chatId || !rosterId || !characterName) return null;

  const previous = db
    .prepare(
      `SELECT score, lastDelta, lastTurnNo
       FROM chat_character_affinity
       WHERE chatId=? AND rosterId=?`
    )
    .get(chatId, rosterId) as any;
  const previousScore = clampInt(previous?.score ?? 50, 0, 100);
  const previousDelta = clampInt(previous?.lastDelta ?? 0, -3, 3);
  const previousTurnNo = Math.max(0, Math.trunc(Number(previous?.lastTurnNo || 0)));
  const baseScore =
    previous && previousTurnNo === turnNo
      ? previousScore - previousDelta
      : previousScore;
  const score = clampInt(baseScore + delta, 0, 100);
  const now = Date.now();

  db.prepare(
    `INSERT INTO chat_character_affinity
       (id, chatId, rosterId, personaName, characterName, score, lastDelta,
        reason, evidence, lastTurnNo, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chatId, rosterId) DO UPDATE SET
       personaName=excluded.personaName,
       characterName=excluded.characterName,
       score=excluded.score,
       lastDelta=excluded.lastDelta,
       reason=excluded.reason,
       evidence=excluded.evidence,
       lastTurnNo=excluded.lastTurnNo,
       updatedAt=excluded.updatedAt`
  ).run(
    randomUUID(),
    chatId,
    rosterId,
    personaName,
    characterName,
    score,
    delta,
    encryptIfPossible(cleanText(params.reason, 500)),
    encryptIfPossible(cleanText(params.evidence, 500)),
    turnNo,
    now,
    now
  );

  return { score, delta, label: affinityLabel(score) };
}

export function loadRelationshipGraph(chatIdRaw: string): RelationshipGraphData {
  const chatId = cleanText(chatIdRaw, 120);
  if (!chatId) return { personaName: "", nodes: [], relations: [], affinities: [] };
  const relations = (
    db
      .prepare(
        `SELECT r.id, r.subjectKey, r.subjectName, r.relation, r.slotKey,
                r.objectKey, r.objectName, r.objectRole, r.firstSeenTurn,
                r.lastSeenTurn, r.updatedAt,
                COALESCE(sr.id, '') AS subjectRosterId,
                COALESCE(orr.id, '') AS objectRosterId
         FROM chat_character_relations r
         LEFT JOIN chat_character_roster sr ON sr.chatId=r.chatId AND sr.name=r.subjectName
         LEFT JOIN chat_character_roster orr ON orr.chatId=r.chatId AND orr.name=r.objectName
         WHERE r.chatId=?
         ORDER BY r.subjectName ASC, r.relation ASC, r.slotKey ASC`
      )
      .all(chatId) as any[]
  ).map((row) => ({
    id: String(row?.id || ""),
    subjectKey: String(row?.subjectKey || ""),
    subjectName: String(row?.subjectName || ""),
    subjectRosterId: String(row?.subjectRosterId || ""),
    relation: String(row?.relation || ""),
    slotKey: String(row?.slotKey || ""),
    objectKey: String(row?.objectKey || ""),
    objectName: String(row?.objectName || ""),
    objectRosterId: String(row?.objectRosterId || ""),
    objectRole: String(row?.objectRole || ""),
    firstSeenTurn: Number(row?.firstSeenTurn || 0),
    lastSeenTurn: Number(row?.lastSeenTurn || 0),
    updatedAt: Number(row?.updatedAt || 0),
  }));
  const affinities = (
    db
      .prepare(
        `SELECT id, rosterId, personaName, characterName, score, lastDelta,
                reason, evidence, lastTurnNo, updatedAt
         FROM chat_character_affinity
         WHERE chatId=?
         ORDER BY score DESC, characterName ASC`
      )
      .all(chatId) as any[]
  ).map((row) => {
    const score = clampInt(row?.score ?? 50, 0, 100);
    return {
      id: String(row?.id || ""),
      rosterId: String(row?.rosterId || ""),
      personaName: String(row?.personaName || ""),
      characterName: String(row?.characterName || ""),
      score,
      label: affinityLabel(score),
      lastDelta: clampInt(row?.lastDelta ?? 0, -3, 3),
      reason: decryptIfPossible(String(row?.reason || "")),
      evidence: decryptIfPossible(String(row?.evidence || "")),
      lastTurnNo: Number(row?.lastTurnNo || 0),
      updatedAt: Number(row?.updatedAt || 0),
    };
  });
  const personaName =
    affinities.find((row) => row.personaName)?.personaName ||
    relations.find((row) => row.subjectKey === "persona")?.subjectName ||
    "";
  const nodes = loadCharacterGraphNodes(chatId);
  return { personaName, nodes, relations, affinities };
}

export function formatRelationshipGraphBlock(graph: RelationshipGraphData) {
  const lines: string[] = [
    "# [저장된 관계도·현재 나이 — 최신 정사, 기본 프로필보다 우선]",
    "- 아래 나이는 명시된 나이와 이후 시간 경과를 합산한 현재값이다. 초기 페르소나/인물 프로필의 나이와 다르면 아래 현재 나이를 따른다.",
  ];
  for (const node of graph.nodes.filter((item) => item.age > 0).slice(0, 60)) {
    lines.push(`- ${node.name} 현재 나이: ${node.age}세`);
  }
  for (const relation of graph.relations.slice(0, 60)) {
    lines.push(
      `- ${relation.subjectName} → ${relation.relation} → ${
        relation.objectName || `이름 미상(${relation.objectRole})`
      }`
    );
  }
  for (const affinity of graph.affinities.slice(0, 40)) {
    lines.push(
      `- ${affinity.characterName}이(가) ${affinity.personaName || "주인공"}에게 느끼는 호감도: ${
        affinity.score
      }/100 (${affinity.label})`
    );
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
