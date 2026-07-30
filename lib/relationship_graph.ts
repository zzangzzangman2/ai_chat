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
  relationshipLabel: string;
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
  if (score >= 43) return "보통";
  if (score >= 28) return "경계";
  if (score >= 15) return "냉담";
  return "적대";
}

const RELATIONSHIP_SIGNAL_RULES: Array<[label: string, pattern: RegExp]> = [
  ["원수", /(철천지원수|불구대천|원수|복수(?:의)?\s*대상|복수해야|원한|삶을\s*(?:짓밟|파괴)|평생[^.!?]{0,30}저주)/u],
  ["악연", /(악연|(?:인생|삶)을\s*(?:망치|짓밟|파괴)|파멸시|비극의\s*원인)/u],
  ["숙적", /(숙적|라이벌|경쟁자|맞수)/u],
  ["공포", /(극심한\s*공포|공포에\s*질|두려워|무서워|벌벌\s*떨|살려\s*달라)/u],
  ["적대", /(적대|적군|대적|살해|죽이려|죽여야|증오|혐오|악마|가해자)/u],
  ["배우자", /(배우자|남편|아내|부부|신랑|신부)/u],
  ["연인", /(연인|애인|남자친구|여자친구|약혼|사랑하는\s*사이)/u],
  ["아버지", /(?:친부|양부|아버지|아빠)/u],
  ["어머니", /(?:친모|양모|어머니|엄마)/u],
  ["딸", /(?:친딸|양딸|딸아이|딸)(?=\s|[,.!?]|$|이|은|는|을|를|과|와|로|에게)/u],
  ["아들", /(?:친아들|양아들|아들)(?=\s|[,.!?]|$|이|은|는|을|를|과|와|로|에게)/u],
  ["손녀", /손녀/u],
  ["손자", /손자/u],
  ["형제자매", /(형제|자매|남매|오빠|언니|누나|동생)/u],
  ["가족", /(가족|혈육|친척)/u],
  ["절친", /(절친|가장\s*친한\s*친구|소꿉친구)/u],
  ["친구", /(친구|동창)/u],
  ["스승", /(스승|선생님|교사|교수|멘토)/u],
  ["제자", /(제자|학생|후배)/u],
  ["보호자", /(보호자|후견인|돌봐|보호해)/u],
  ["동료", /(동료|동업자|팀원|전우|협력자)/u],
  ["상사", /(상사|사장|대표|고용주|주군)/u],
  ["부하", /(부하|직원|고용인|수하|하인)/u],
  ["채무 관계", /(채무|빚|채권자|채무자)/u],
  ["의심", /(의심|수상해|믿지\s*못|불신)/u],
  ["경계", /(경계|조심|거리(?:를)?\s*두|꺼려)/u],
  ["동맹", /(동맹|한편|공조|연합)/u],
  ["신뢰", /(신뢰|믿고|의지하|은인)/u],
];

const DIRECT_RELATIONSHIP_LABELS = new Set([
  "배우자", "연인", "아버지", "어머니", "딸", "아들", "손녀", "손자",
  "형제자매", "가족", "절친", "친구", "스승", "제자", "보호자", "동료",
  "상사", "부하", "채무 관계",
]);

function cleanRelationshipSource(value: unknown) {
  return decryptIfPossible(String(value || ""))
    .replace(/\s+/g, " ")
    .trim();
}

export function narrativeRelationshipLabel(params: {
  score: number;
  lastTurnNo?: number;
  role?: unknown;
  profile?: unknown;
  relationshipNote?: unknown;
  emotionNote?: unknown;
  status?: unknown;
  reason?: unknown;
  evidence?: unknown;
  memories?: unknown[];
}) {
  const directSource = [
    params.relationshipNote,
    params.role,
  ]
    .map(cleanRelationshipSource)
    .filter(Boolean)
    .join(" ");
  const source = [
    params.relationshipNote,
    params.role,
    params.profile,
    params.emotionNote,
    params.status,
    params.reason,
    params.evidence,
    ...(Array.isArray(params.memories) ? params.memories : []),
  ]
    .map(cleanRelationshipSource)
    .filter(Boolean)
    .join(" ");
  for (const [label, pattern] of RELATIONSHIP_SIGNAL_RULES) {
    if (directSource && pattern.test(directSource)) return label;
  }
  for (const [label, pattern] of RELATIONSHIP_SIGNAL_RULES) {
    if (DIRECT_RELATIONSHIP_LABELS.has(label)) continue;
    if (pattern.test(source)) return label;
  }

  const score = clampInt(params.score, 0, 100);
  const hasInteraction = Math.max(0, Number(params.lastTurnNo || 0)) > 0;
  if (!hasInteraction) return "관계 미정";
  if (score >= 85) return "깊은 신뢰";
  if (score >= 70) return "가까운 사이";
  if (score >= 58) return "우호";
  if (score >= 43) return "거리 유지";
  if (score >= 28) return "경계";
  if (score >= 15) return "불신";
  return "적대";
}

function relationshipBaselineScore(label: string) {
  if (label === "원수") return 5;
  if (label === "악연") return 12;
  if (label === "적대") return 15;
  if (label === "공포") return 18;
  if (label === "숙적") return 25;
  if (label === "의심") return 35;
  if (label === "경계") return 38;
  if (label === "동맹") return 65;
  if (label === "신뢰") return 72;
  return 50;
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

  const latestTurns = db
    .prepare(
      `SELECT rosterId, MAX(turnNo) AS latestTurn
       FROM chat_character_turn_memories
       WHERE chatId=?
       GROUP BY rosterId`
    )
    .all(chatId) as Array<{ rosterId?: string; latestTurn?: number }>;
  const latestTurnByRoster = new Map(
    latestTurns
      .map((row) => [String(row?.rosterId || ""), Math.max(0, Number(row?.latestTurn || 0))] as const)
      .filter(([rosterId, latestTurn]) => Boolean(rosterId) && latestTurn > 0)
  );
  if (!latestTurnByRoster.size) return;

  const memoryTextByRoster = new Map<string, string[]>();
  const memoryRows = db
    .prepare(
      `SELECT rosterId, summary
       FROM chat_character_turn_memories
       WHERE chatId=?
       ORDER BY turnNo DESC
       LIMIT 240`
    )
    .all(chatId) as Array<{ rosterId?: string; summary?: string }>;
  for (const row of memoryRows) {
    const rosterId = String(row?.rosterId || "");
    if (!latestTurnByRoster.has(rosterId)) continue;
    const values = memoryTextByRoster.get(rosterId) || [];
    if (values.length >= 8) continue;
    values.push(decryptIfPossible(String(row?.summary || "")));
    memoryTextByRoster.set(rosterId, values);
  }

  const candidates = db
    .prepare(
      `SELECT a.rosterId, a.score, a.lastTurnNo, a.reason,
              r.role, r.profile, r.relationshipNote, r.emotionNote, r.status
       FROM chat_character_affinity a
       LEFT JOIN chat_character_roster r
         ON r.chatId=a.chatId AND r.id=a.rosterId
       WHERE a.chatId=? AND a.lastTurnNo=0`
    )
    .all(chatId) as any[];
  const updateBaseline = db.prepare(
    `UPDATE chat_character_affinity
     SET score=?, lastDelta=0, reason=?, evidence='', lastTurnNo=?, updatedAt=?
     WHERE chatId=? AND rosterId=? AND lastTurnNo=0`
  );
  const backfill = db.transaction(() => {
    for (const row of candidates) {
      const rosterId = String(row?.rosterId || "");
      const latestTurn = latestTurnByRoster.get(rosterId) || 0;
      if (!latestTurn) continue;
      const relationshipLabel = narrativeRelationshipLabel({
        score: Number(row?.score ?? 50),
        lastTurnNo: latestTurn,
        role: row?.role,
        profile: row?.profile,
        relationshipNote: row?.relationshipNote,
        emotionNote: row?.emotionNote,
        status: row?.status,
        reason: row?.reason,
        memories: memoryTextByRoster.get(rosterId) || [],
      });
      const score = relationshipBaselineScore(relationshipLabel);
      if (score === 50) continue;
      updateBaseline.run(
        score,
        encryptIfPossible(`기존 개별 장기기억 기반 초기 관계: ${relationshipLabel}`),
        latestTurn,
        now,
        chatId,
        rosterId
      );
    }
  });
  backfill();
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
  const memoryTextByRoster = new Map<string, string[]>();
  const recentMemoryRows = db
    .prepare(
      `SELECT rosterId, summary
       FROM chat_character_turn_memories
       WHERE chatId=?
       ORDER BY turnNo DESC
       LIMIT 240`
    )
    .all(chatId) as Array<{ rosterId?: string; summary?: string }>;
  for (const row of recentMemoryRows) {
    const rosterId = String(row?.rosterId || "");
    if (!rosterId) continue;
    const values = memoryTextByRoster.get(rosterId) || [];
    if (values.length >= 8) continue;
    values.push(decryptIfPossible(String(row?.summary || "")));
    memoryTextByRoster.set(rosterId, values);
  }

  const affinities = (
    db
      .prepare(
        `SELECT a.id, a.rosterId, a.personaName, a.characterName, a.score, a.lastDelta,
                a.reason, a.evidence, a.lastTurnNo, a.updatedAt,
                COALESCE(r.role, '') AS role,
                COALESCE(r.profile, '') AS profile,
                COALESCE(r.relationshipNote, '') AS relationshipNote,
                COALESCE(r.emotionNote, '') AS emotionNote,
                COALESCE(r.status, '') AS status
         FROM chat_character_affinity a
         LEFT JOIN chat_character_roster r
           ON r.chatId=a.chatId AND r.id=a.rosterId
         WHERE a.chatId=?
         ORDER BY score DESC, characterName ASC`
      )
      .all(chatId) as any[]
  ).map((row) => {
    const score = clampInt(row?.score ?? 50, 0, 100);
    const reason = decryptIfPossible(String(row?.reason || ""));
    const evidence = decryptIfPossible(String(row?.evidence || ""));
    return {
      id: String(row?.id || ""),
      rosterId: String(row?.rosterId || ""),
      personaName: String(row?.personaName || ""),
      characterName: String(row?.characterName || ""),
      score,
      label: affinityLabel(score),
      relationshipLabel: narrativeRelationshipLabel({
        score,
        lastTurnNo: Number(row?.lastTurnNo || 0),
        role: row?.role,
        profile: row?.profile,
        relationshipNote: row?.relationshipNote,
        emotionNote: row?.emotionNote,
        status: row?.status,
        reason,
        evidence,
        memories: memoryTextByRoster.get(String(row?.rosterId || "")) || [],
      }),
      lastDelta: clampInt(row?.lastDelta ?? 0, -3, 3),
      reason,
      evidence,
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
      `- ${affinity.characterName} ↔ ${affinity.personaName || "주인공"} 관계 성격: ${
        affinity.relationshipLabel
      }; 호감도: ${affinity.score}/100 (${affinity.label})`
    );
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
