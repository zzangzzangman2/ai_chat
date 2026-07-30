import { randomUUID } from "crypto";

import { db } from "@/lib/db";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import type { IdentityCanon } from "@/lib/identity_memory";
import {
  loadCharacterGraphNodes,
  type CharacterGraphNode,
} from "@/lib/character_vitals";
import {
  contextualRelationshipLabel,
  inferCharacterOccupation,
  isContextualSymmetricRelationship,
  isInvalidRelationshipLabel,
  inferPersonaOccupationFromScenario,
} from "@/lib/relationship_context";

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
  source: "manual" | "structured" | "identity" | "contextual";
  isManual: boolean;
};

export type CharacterAffinity = {
  id: string;
  rosterId: string;
  personaName: string;
  characterName: string;
  job: string;
  memoryCount: number;
  latestMemory: string;
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

export function stableRelationshipNameKey(name: string, personaName: string) {
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

const STRUCTURAL_RELATIONSHIP_RULES: Array<[label: string, pattern: RegExp]> = [
  ["같은 반 친구", /(같은\s*반\s*친구|반\s*친구|학급\s*친구)/u],
  ["동급생", /(동급생|같은\s*학년)/u],
  ["같은 학교", /(같은\s*학교|동문)/u],
  ["소꿉친구", /소꿉친구/u],
  ["절친", /(절친|가장\s*친한\s*친구)/u],
  ["친구", /친구/u],
  ["배우자", /(배우자|남편|아내|부부|신랑|신부)/u],
  ["연인", /(연인|애인|남자친구|여자친구|약혼|사랑하는\s*사이)/u],
  ["아버지", /(?:친부|양부|아버지|아빠)/u],
  ["어머니", /(?:친모|양모|어머니|엄마)/u],
  ["딸", /(?:친딸|양딸|딸아이|딸)(?=\s|[,.!?]|$|이|은|는|을|를|과|와|로|에게)/u],
  ["아들", /(?:친아들|양아들|아들)(?=\s|[,.!?]|$|이|은|는|을|를|과|와|로|에게)/u],
  ["손녀", /손녀/u],
  ["손자", /손자/u],
  ["여동생", /여동생/u],
  ["남동생", /남동생/u],
  ["언니", /언니/u],
  ["누나", /누나/u],
  ["오빠", /오빠/u],
  ["형", /형(?!제)/u],
  ["형제자매", /(형제자매|형제|자매|남매|동생)/u],
  ["가족", /(가족|혈육|친척)/u],
  ["스승", /(스승|선생님|교사|교수|멘토)/u],
  ["제자", /(제자|담당\s*학생)/u],
  ["선배", /선배/u],
  ["후배", /후배/u],
  ["보호자", /(보호자|후견인)/u],
  ["담당자", /(담당자|담당관)/u],
  ["동료", /(동료|동업자|팀원|전우|협력자)/u],
  ["상사", /(상사|사장|대표|고용주|주군)/u],
  ["부하 직원", /(부하\s*직원|부하|고용인|수하|하인)/u],
  ["채무 관계", /(채무|빚|채권자|채무자)/u],
  ["동맹", /(동맹|한편|공조|연합)/u],
  ["원수", /(철천지원수|불구대천|원수)/u],
  ["라이벌", /(라이벌|경쟁자|숙적|맞수)/u],
  ["가해자", /가해자/u],
  ["피해자", /피해자/u],
  ["이웃", /이웃/u],
  ["지인", /지인/u],
];

const LATEST_RELATIONSHIP_TRANSITIONS: Array<[label: string, pattern: RegExp]> = [
  ["이혼한 전 배우자", /(?:이혼했|이혼한|이혼을\s*했|혼인\s*관계.{0,12}(?:끝|종료))/u],
  ["헤어진 전 연인", /(?:헤어졌|결별했|연인\s*관계.{0,12}(?:끝|종료))/u],
  ["배우자", /(?:결혼했|결혼식을|혼인했|부부가\s*되|아내가\s*되|남편이\s*되|배우자가\s*되)/u],
  ["연인", /(?:사귀기\s*시작|연인이\s*되|연애를\s*시작|교제하기\s*시작)/u],
  ["친구", /(?:친구가\s*되|친구로\s*지내기로)/u],
  ["원수", /(?:원수가\s*되|철천지원수가\s*되)/u],
];

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
  characterJob?: unknown;
  personaJob?: unknown;
  recentMemory?: unknown;
  memoryCount?: unknown;
  reason?: unknown;
  evidence?: unknown;
}) {
  const latestSource = [
    params.recentMemory,
    params.reason,
    params.evidence,
  ]
    .map(cleanRelationshipSource)
    .filter(Boolean)
    .join(" ");
  for (const [label, pattern] of LATEST_RELATIONSHIP_TRANSITIONS) {
    if (latestSource && pattern.test(latestSource)) return label;
  }
  const structuralSource = [
    params.relationshipNote,
    params.role,
    params.profile,
  ]
    .map(cleanRelationshipSource)
    .filter(Boolean)
    .join(" ");
  for (const [label, pattern] of STRUCTURAL_RELATIONSHIP_RULES) {
    if (structuralSource && pattern.test(structuralSource)) return label;
  }
  return contextualRelationshipLabel({
    characterJob: params.characterJob,
    personaJob: params.personaJob,
    role: params.role,
    profile: params.profile,
    relationshipNote: params.relationshipNote,
    recentMemory: params.recentMemory,
    memoryCount: params.memoryCount,
    lastTurnNo: params.lastTurnNo,
    reason: params.reason,
    evidence: params.evidence,
  });
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
      if (!subjectName || !relation || !relatedName) return null;
      const subjectKey = stableRelationshipNameKey(subjectName, personaName);
      const objectKey = stableRelationshipNameKey(relatedName, personaName);
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
  const deleteStructuredDuplicate = db.prepare(
    `DELETE FROM chat_character_relations
     WHERE chatId=? AND subjectKey=? AND relation=? AND objectKey=?
       AND slotKey LIKE 'structured:%'`
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
      deleteStructuredDuplicate.run(chatId, row.subjectKey, row.relation, row.objectKey);
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
      if (
        String(row.slotKey || "").startsWith("structured:") ||
        String(row.slotKey || "").startsWith("manual:")
      ) {
        continue;
      }
      if (!currentKeys.has(key)) {
        deleteStmt.run(String(row.id || ""), chatId);
      }
    }
  });
  write();
  return rows.length;
}

function storedRelationshipSource(slotKeyRaw: unknown) {
  const slotKey = String(slotKeyRaw || "");
  if (slotKey.startsWith("manual:")) return "manual" as const;
  if (slotKey.startsWith("structured:")) return "structured" as const;
  return "identity" as const;
}

function unorderedRelationshipPairKey(subjectKeyRaw: unknown, objectKeyRaw: unknown) {
  return [String(subjectKeyRaw || ""), String(objectKeyRaw || "")]
    .sort((a, b) => a.localeCompare(b, "ko"))
    .join("\u0000");
}

const RELATIONSHIP_EVOLUTION_PRIORITY: Record<string, number> = {
  배우자: 120,
  부부: 120,
  "이혼한 전 배우자": 118,
  연인: 115,
  "헤어진 전 연인": 112,
  아버지: 108,
  어머니: 108,
  부모: 108,
  딸: 108,
  아들: 108,
  자녀: 108,
  손녀: 108,
  손자: 108,
  형제자매: 105,
  원수: 102,
  가해자: 101,
  피해자: 101,
  절친: 98,
  소꿉친구: 96,
  친구: 94,
  동료: 90,
  지인: 80,
};

function selectCurrentStoredRelationships(rows: RelationshipGraphRelation[]) {
  const selected = new Map<string, RelationshipGraphRelation>();
  for (const row of rows) {
    const pairKey = unorderedRelationshipPairKey(row.subjectKey, row.objectKey);
    const previous = selected.get(pairKey);
    if (!previous) {
      selected.set(pairKey, row);
      continue;
    }
    const rowManual = Number(row.isManual);
    const previousManual = Number(previous.isManual);
    const rowPriority = RELATIONSHIP_EVOLUTION_PRIORITY[row.relation] || 0;
    const previousPriority = RELATIONSHIP_EVOLUTION_PRIORITY[previous.relation] || 0;
    const rowSort = [
      rowManual,
      Math.max(0, Number(row.lastSeenTurn || 0)),
      rowPriority,
      Math.max(0, Number(row.updatedAt || 0)),
    ];
    const previousSort = [
      previousManual,
      Math.max(0, Number(previous.lastSeenTurn || 0)),
      previousPriority,
      Math.max(0, Number(previous.updatedAt || 0)),
    ];
    const shouldReplace = rowSort.some(
      (value, index) =>
        value !== previousSort[index] &&
        value > previousSort[index] &&
        rowSort.slice(0, index).every((item, priorIndex) => item === previousSort[priorIndex])
    );
    if (shouldReplace) selected.set(pairKey, row);
  }
  return [...selected.values()];
}

export function setManualRelationship(params: {
  chatId: string;
  personaName: string;
  subjectName: string;
  objectName: string;
  relation: string;
  details?: string;
  turnNo?: number;
}) {
  const chatId = cleanText(params.chatId, 120);
  const personaName = cleanText(params.personaName, 80);
  const subjectName = cleanText(params.subjectName, 80);
  const objectName = cleanText(params.objectName, 80);
  const relation = cleanText(params.relation, 40);
  const details = cleanText(params.details, 500);
  const subjectKey = stableRelationshipNameKey(subjectName, personaName);
  const objectKey = stableRelationshipNameKey(objectName, personaName);
  if (!chatId || !subjectName || !objectName || !relation || subjectKey === objectKey) {
    throw new Error("invalid_manual_relationship");
  }
  if (isInvalidRelationshipLabel(relation)) throw new Error("invalid_relationship_label");
  const now = Date.now();
  const turnNo = Math.max(0, Math.trunc(Number(params.turnNo || 0)));
  const write = db.transaction(() => {
    db.prepare(
      `DELETE FROM chat_character_relations
       WHERE chatId=? AND slotKey LIKE 'manual:%'
         AND ((subjectKey=? AND objectKey=?) OR (subjectKey=? AND objectKey=?))`
    ).run(chatId, subjectKey, objectKey, objectKey, subjectKey);
    db.prepare(
      `INSERT INTO chat_character_relations
         (id, chatId, subjectKey, subjectName, relation, slotKey, objectKey,
          objectName, objectRole, sourceOrder, firstSeenTurn, lastSeenTurn,
          createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      chatId,
      subjectKey,
      subjectName,
      relation,
      cleanText(`manual:${objectKey}`, 80),
      objectKey,
      objectName,
      details || "사용자가 직접 지정한 현재 관계",
      turnNo,
      turnNo,
      turnNo,
      now,
      now
    );
  });
  write();
}

export function clearManualRelationship(params: {
  chatId: string;
  personaName: string;
  subjectName: string;
  objectName: string;
}) {
  const chatId = cleanText(params.chatId, 120);
  const subjectKey = stableRelationshipNameKey(params.subjectName, params.personaName);
  const objectKey = stableRelationshipNameKey(params.objectName, params.personaName);
  if (!chatId || !subjectKey || !objectKey || subjectKey === objectKey) return 0;
  return Number(
    db.prepare(
      `DELETE FROM chat_character_relations
       WHERE chatId=? AND slotKey LIKE 'manual:%'
         AND ((subjectKey=? AND objectKey=?) OR (subjectKey=? AND objectKey=?))`
    ).run(chatId, subjectKey, objectKey, objectKey, subjectKey).changes || 0
  );
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

  const artificialRows = db
    .prepare(`SELECT rosterId, reason FROM chat_character_affinity WHERE chatId=?`)
    .all(chatId) as Array<{ rosterId?: string; reason?: string }>;
  const resetArtificial = db.prepare(
    `UPDATE chat_character_affinity
     SET score=50, lastDelta=0, reason='', evidence='', lastTurnNo=0, updatedAt=?
     WHERE chatId=? AND rosterId=?`
  );
  const repair = db.transaction(() => {
    for (const row of artificialRows) {
      const rosterId = String(row?.rosterId || "");
      const reason = decryptIfPossible(String(row?.reason || ""));
      if (!rosterId || !reason.startsWith("기존 개별 장기기억 기반 초기 관계:")) continue;
      resetArtificial.run(now, chatId, rosterId);
    }
  });
  repair();
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
  const settings = db
    .prepare(`SELECT personaName, personaInfo FROM chat_settings WHERE chatId=?`)
    .get(chatId) as { personaName?: unknown; personaInfo?: unknown } | undefined;
  const settingsPersonaName = cleanText(settings?.personaName, 80);
  const personaInfo = cleanRelationshipSource(settings?.personaInfo);
  const personaScenario = (
    db
      .prepare(
        `SELECT content
         FROM messages
         WHERE chatId=? AND LOWER(role)='user'
         ORDER BY createdAt ASC, id ASC
         LIMIT 8`
      )
      .all(chatId) as Array<{ content?: unknown }>
  )
    .map((row) => decryptIfPossible(String(row?.content || "")))
    .join("\n");
  const personaJob =
    inferCharacterOccupation(personaInfo) ||
    inferPersonaOccupationFromScenario(personaScenario);
  const rawNodes = loadCharacterGraphNodes(chatId).map((node) => ({
    ...node,
    job: inferCharacterOccupation(
      node.isPersona ? personaJob : "",
      node.role,
      node.profile
    ),
  }));
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
         WHERE r.chatId=? AND TRIM(r.objectName) <> ''
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
    source: storedRelationshipSource(row?.slotKey),
    isManual: String(row?.slotKey || "").startsWith("manual:"),
  }));

  const affinities = (
    db
      .prepare(
        `SELECT a.id, a.rosterId, a.personaName, a.characterName, a.score, a.lastDelta,
                a.reason, a.evidence, a.lastTurnNo, a.updatedAt,
                COALESCE(r.role, '') AS role,
                COALESCE(r.profile, '') AS profile,
                COALESCE(r.relationshipNote, '') AS relationshipNote,
                (SELECT COUNT(*)
                   FROM chat_character_turn_memories m
                  WHERE m.chatId=a.chatId AND m.rosterId=a.rosterId) AS memoryCount,
                COALESCE((SELECT m.summary
                   FROM chat_character_turn_memories m
                  WHERE m.chatId=a.chatId AND m.rosterId=a.rosterId
                  ORDER BY m.turnNo DESC LIMIT 1), '') AS latestMemorySummary,
                COALESCE((SELECT m.evidence
                   FROM chat_character_turn_memories m
                  WHERE m.chatId=a.chatId AND m.rosterId=a.rosterId
                  ORDER BY m.turnNo DESC LIMIT 1), '') AS latestMemoryEvidence
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
    const role = decryptIfPossible(String(row?.role || ""));
    const profile = decryptIfPossible(String(row?.profile || ""));
    const relationshipNote = decryptIfPossible(String(row?.relationshipNote || ""));
    const latestMemorySummary = decryptIfPossible(String(row?.latestMemorySummary || ""));
    const latestMemoryEvidence = decryptIfPossible(String(row?.latestMemoryEvidence || ""));
    const latestMemory = cleanText(
      [latestMemorySummary, latestMemoryEvidence].filter(Boolean).join(" / "),
      600
    );
    const job = inferCharacterOccupation(role, profile);
    const memoryCount = Math.max(0, Number(row?.memoryCount || 0));
    return {
      id: String(row?.id || ""),
      rosterId: String(row?.rosterId || ""),
      personaName: String(row?.personaName || ""),
      characterName: String(row?.characterName || ""),
      job,
      memoryCount,
      latestMemory,
      score,
      label: affinityLabel(score),
      relationshipLabel: narrativeRelationshipLabel({
        score,
        lastTurnNo: Number(row?.lastTurnNo || 0),
        role,
        profile,
        relationshipNote,
        characterJob: job,
        personaJob,
        recentMemory: latestMemory,
        memoryCount,
        reason,
        evidence,
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
    settingsPersonaName;
  const normalizedPersona = cleanText(personaName, 80).toLocaleLowerCase("ko-KR");
  const normalizedRelations = selectCurrentStoredRelationships(relations.map((row) => {
    const subjectIsPersona =
      Boolean(normalizedPersona) &&
      cleanText(row.subjectName, 80).toLocaleLowerCase("ko-KR") === normalizedPersona;
    const objectIsPersona =
      Boolean(normalizedPersona) &&
      cleanText(row.objectName, 80).toLocaleLowerCase("ko-KR") === normalizedPersona;
    return {
      ...row,
      subjectKey: subjectIsPersona ? "persona" : row.subjectKey,
      subjectRosterId: subjectIsPersona ? "" : row.subjectRosterId,
      objectKey: objectIsPersona ? "persona" : row.objectKey,
      objectRosterId: objectIsPersona ? "" : row.objectRosterId,
    };
  }).filter((row) => !isInvalidRelationshipLabel(row.relation)));
  const personaRelationByName = new Map<string, string>();
  for (const relation of normalizedRelations) {
    if (relation.subjectKey === "persona") {
      personaRelationByName.set(
        cleanText(relation.objectName, 80).toLocaleLowerCase("ko-KR"),
        relation.relation
      );
    } else if (relation.objectKey === "persona") {
      personaRelationByName.set(
        cleanText(relation.subjectName, 80).toLocaleLowerCase("ko-KR"),
        relation.relation
      );
    }
  }
  const normalizedAffinities = affinities
    .filter(
      (row) =>
        !normalizedPersona ||
        cleanText(row.characterName, 80).toLocaleLowerCase("ko-KR") !== normalizedPersona
    )
    .map((row) => ({
      ...row,
      relationshipLabel:
        personaRelationByName.get(cleanText(row.characterName, 80).toLocaleLowerCase("ko-KR")) ||
        row.relationshipLabel,
    }));
  const nodes = rawNodes.filter(
    (node) =>
      !node.isUnknown &&
      Boolean(String(node.name || "").trim()) &&
      (!normalizedPersona ||
        node.isPersona ||
        cleanText(node.name, 80).toLocaleLowerCase("ko-KR") !== normalizedPersona)
  );
  const directPersonaNames = new Set<string>();
  for (const relation of normalizedRelations) {
    if (relation.subjectKey === "persona") {
      directPersonaNames.add(cleanText(relation.objectName, 80).toLocaleLowerCase("ko-KR"));
    }
    if (relation.objectKey === "persona") {
      directPersonaNames.add(cleanText(relation.subjectName, 80).toLocaleLowerCase("ko-KR"));
    }
  }
  const affinityByRoster = new Map(
    normalizedAffinities.map((affinity) => [affinity.rosterId, affinity])
  );
  const affinityByName = new Map(
    normalizedAffinities.map((affinity) => [
      cleanText(affinity.characterName, 80).toLocaleLowerCase("ko-KR"),
      affinity,
    ])
  );
  const contextualRelations = nodes
    .filter((node) => !node.isPersona && node.key !== "persona")
    .filter(
      (node) =>
        !directPersonaNames.has(cleanText(node.name, 80).toLocaleLowerCase("ko-KR"))
    )
    .map((node) => {
      const affinity =
        affinityByRoster.get(node.rosterId) ||
        affinityByName.get(cleanText(node.name, 80).toLocaleLowerCase("ko-KR"));
      const relation =
        affinity?.relationshipLabel ||
        contextualRelationshipLabel({
          characterJob: node.job,
          personaJob,
          role: node.role,
          profile: node.profile,
          relationshipNote: node.relationshipNote,
        });
      const detailParts = [
        node.job ? `직업: ${node.job}` : "",
        affinity?.latestMemory ? `최근 개별 기억: ${cleanText(affinity.latestMemory, 260)}` : "",
        "직업·배경·개별 장기기억을 바탕으로 자동 추론한 현재 관계",
      ].filter(Boolean);
      return {
        id: `contextual:${node.rosterId || node.key}`,
        subjectKey: "persona",
        subjectName: personaName || "주인공",
        subjectRosterId: "",
        relation,
        slotKey: `contextual:${node.rosterId || node.key}`,
        objectKey: node.key,
        objectName: node.name,
        objectRosterId: node.rosterId,
        objectRole: detailParts.join("; "),
        firstSeenTurn: 0,
        lastSeenTurn: Math.max(0, Number(affinity?.lastTurnNo || 0)),
        updatedAt: Math.max(Number(node.updatedAt || 0), Number(affinity?.updatedAt || 0)),
        source: "contextual" as const,
        isManual: false,
      };
    });
  return {
    personaName,
    nodes,
    relations: [...normalizedRelations, ...contextualRelations],
    affinities: normalizedAffinities,
  };
}

const SYMMETRIC_RELATIONS = new Set([
  "배우자", "부부", "연인", "친구", "절친", "소꿉친구", "같은 반 친구",
  "동급생", "같은 학교", "동료", "동맹", "라이벌", "원수", "이웃", "지인",
]);

export function formatRelationshipGraphBlock(graph: RelationshipGraphData) {
  const lines: string[] = [
    "# [저장된 관계도·현재 나이 — 최신 정사, 기본 프로필보다 우선]",
    "- 아래 나이는 명시된 나이와 이후 시간 경과를 합산한 현재값이다. 초기 페르소나/인물 프로필의 나이와 다르면 아래 현재 나이를 따른다.",
  ];
  for (const node of graph.nodes.filter((item) => item.age > 0).slice(0, 60)) {
    lines.push(`- ${node.name} 현재 나이: ${node.age}세`);
  }
  for (const node of graph.nodes.filter((item) => item.job).slice(0, 60)) {
    lines.push(`- ${node.name} 직업: ${node.job}`);
  }
  for (const relation of graph.relations.slice(0, 60)) {
    if (!relation.objectName) continue;
    const details = cleanText(relation.objectRole, 500);
    const generatedRole = `${relation.subjectName}의 ${relation.relation}`;
    const detailSuffix =
      details && details !== generatedRole ? `; 세부: ${details}` : "";

    lines.push(
      SYMMETRIC_RELATIONS.has(relation.relation) || isContextualSymmetricRelationship(relation.relation)
        ? `- ${relation.subjectName} ↔ ${relation.objectName}: ${relation.relation}${detailSuffix}`
        : `- ${relation.subjectName} → ${relation.relation} → ${relation.objectName}${detailSuffix}`
    );
  }
  for (const affinity of graph.affinities.slice(0, 40)) {
    lines.push(
      `- ${affinity.characterName} ↔ ${affinity.personaName || "주인공"} 구조적 관계: ${
        affinity.relationshipLabel
      }; 호감도: ${affinity.score}/100 (${affinity.label})`
    );
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
