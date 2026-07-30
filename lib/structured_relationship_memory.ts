import { randomUUID } from "crypto";

import { generateText } from "@/lib/ai";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { db } from "@/lib/db";

export const STRUCTURED_RELATION_TYPES = [
  "아버지",
  "어머니",
  "부모",
  "딸",
  "아들",
  "자녀",
  "할아버지",
  "할머니",
  "조부모",
  "손녀",
  "손자",
  "손자녀",
  "언니",
  "누나",
  "오빠",
  "형",
  "동생",
  "여동생",
  "남동생",
  "자매",
  "형제",
  "형제자매",
  "배우자",
  "연인",
  "친구",
  "절친",
  "소꿉친구",
  "같은 반 친구",
  "동급생",
  "같은 학교",
  "선배",
  "후배",
  "동료",
  "상사",
  "부하 직원",
  "고용주",
  "비서",
  "스승",
  "제자",
  "의사",
  "환자",
  "보호자",
  "피보호자",
  "주인",
  "하인",
  "담당자",
  "이웃",
  "지인",
  "동맹",
  "라이벌",
  "원수",
  "가해자",
  "피해자",
] as const;

const ROLE_LIKE_NAME_PATTERN =
  /^[가-힣A-Za-z]{1,8}(?:대표|사장|교수|박사|원장|팀장|실장|과장|부장|대리|비서|선생)$/u;
const RELATION_TYPE_SET = new Set<string>(STRUCTURED_RELATION_TYPES);
const PERSON_NAME_PATTERN = /^(?:[가-힣]{2,8}|[A-Za-z][A-Za-z0-9._-]{1,39})$/u;
const NON_CHARACTER_NAMES = new Set([
  "사용자",
  "주인공",
  "플레이어",
  "유저",
  "독자",
  "관객",
  "본인",
  "자기",
  "당신",
  "그녀",
  "우리",
  "저희",
  "그들",
  "남자",
  "여자",
  "사람",
  "누군가",
  "상대",
  "상대방",
  "등장인물",
  "캐릭터",
  "이름 미상",
  "엄마",
  "아빠",
  "어머니",
  "아버지",
  "부모",
  "형",
  "누나",
  "오빠",
  "언니",
  "동생",
  "형제",
  "자매",
  "할머니",
  "할아버지",
  "삼촌",
  "이모",
  "고모",
  "조카",
  "사촌",
  "친구",
  "지인",
  "동기",
  "동료",
  "선배",
  "후배",
  "사장",
  "사장님",
  "대표",
  "대표님",
  "비서",
  "선생",
  "선생님",
  "교수",
  "교수님",
  "박사",
  "원장",
  "팀장",
  "과장",
  "부장",
  "대리",
  "직원",
  "학생",
  "교사",
  "의사",
  "환자",
  "보호자",
  "주인",
  "주인님",
  "하인",
  "아저씨",
  "아줌마",
  "아이",
  "소녀",
  "소년",
]);
const NON_PERSISTENT_ALIASES = new Set([
  "나",
  "저",
  "너",
  "당신",
  "그",
  "그녀",
  "그들",
  "우리",
  "저희",
  "자기",
  "본인",
  "누구",
  "누군가",
  "상대",
  "상대방",
  "이놈",
  "그놈",
  "저놈",
]);

export type ExistingStructuredCharacter = {
  id: string;
  mainName: string;
  aliases: string[];
};

export type StructuredCharacter = {
  id: string;
  mainName: string;
  aliases: string[];
  profile: string;
  evidence: string;
};

export type StructuredRelationship = {
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  relation: string;
  details: string;
  evidence: string;
};

export type StructuredCharacterGraph = {
  ok: boolean;
  characters: StructuredCharacter[];
  relationships: StructuredRelationship[];
};

function cleanText(value: unknown, max = 400) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizedKey(value: unknown) {
  return cleanText(value, 80).toLocaleLowerCase("ko-KR");
}

export function splitStoredCharacterAliases(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return [] as string[];
  const values: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.aliases)
        ? parsed.aliases
        : [];
    for (const item of source) {
      const alias = cleanText(item, 80);
      if (alias) values.push(alias);
    }
    if (values.length) return [...new Set(values)];
  } catch {
    // Legacy rows use comma/newline separated aliases.
  }
  for (const item of raw.split(/[\n,;\/|]+/g)) {
    const alias = cleanText(item, 80);
    if (alias) values.push(alias);
  }
  return [...new Set(values)];
}

export function loadStructuredCharacterIdentities(chatIdRaw: string) {
  const chatId = cleanText(chatIdRaw, 120);
  if (!chatId) return [] as ExistingStructuredCharacter[];
  const rows = db
    .prepare(
      `SELECT id, name, aliases
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0
       ORDER BY updatedAt DESC, name ASC
       LIMIT 80`
    )
    .all(chatId) as Array<{ id?: string; name?: string; aliases?: string }>;
  return rows
    .map((row) => ({
      id: cleanText(row?.id, 120),
      mainName: cleanText(row?.name, 80),
      aliases: splitStoredCharacterAliases(
        decryptIfPossible(String(row?.aliases || ""))
      ),
    }))
    .filter((row) => row.id && row.mainName);
}

const STRUCTURED_GRAPH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["characters", "relationships"],
  properties: {
    characters: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "main_name", "aliases", "profile", "evidence"],
        properties: {
          id: { type: "string" },
          main_name: { type: "string" },
          aliases: {
            type: "array",
            maxItems: 20,
            items: { type: "string" },
          },
          profile: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    relationships: {
      type: "array",
      maxItems: 160,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "source_id",
          "target_id",
          "relation",
          "details",
          "evidence",
        ],
        properties: {
          source_id: { type: "string" },
          target_id: { type: "string" },
          relation: {
            type: "string",
            enum: [...STRUCTURED_RELATION_TYPES],
          },
          details: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;

type StructuredGraphResponseShape = {
  characters?: unknown;
  relationships?: unknown;
};

function extractJsonObject(raw: string): unknown {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/u);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function exactEvidence(raw: string, value: unknown) {
  const evidence = cleanText(value, 500);
  return evidence.length >= 2 && raw.includes(evidence) ? evidence : "";
}

function safeAliases(raw: string, mainName: string, values: unknown) {
  if (!Array.isArray(values)) return [] as string[];
  const aliases = new Set<string>();
  for (const value of values) {
    const alias = cleanText(value, 80);
    if (
      !alias ||
      normalizedKey(alias) === normalizedKey(mainName) ||
      NON_PERSISTENT_ALIASES.has(alias) ||
      !raw.includes(alias)
    ) {
      continue;
    }
    aliases.add(alias);
  }
  return [...aliases].slice(0, 20);
}

export async function extractStructuredCharacterGraph(params: {
  rawWindowText: string;
  personaName: string;
  existingCharacters: ExistingStructuredCharacter[];
  llmOpts: {
    model: string;
    maxOutputTokens: number;
    maxReasoningTokens: number;
    thinkingBudget: number;
  };
  windowStartTurn: number;
  windowEndTurn: number;
}): Promise<StructuredCharacterGraph> {
  const raw = String(params.rawWindowText || "").trim();
  if (!raw || raw.length < 40) {
    return { ok: true, characters: [], relationships: [] };
  }

  const personaName = cleanText(params.personaName, 80);
  const existing = params.existingCharacters.slice(0, 80);
  const registry = [
    ...(personaName
      ? [{ id: "persona", main_name: personaName, aliases: ["주인공", "페르소나"] }]
      : []),
    ...existing.map((item) => ({
      id: item.id,
      main_name: item.mainName,
      aliases: item.aliases,
    })),
  ];
  const system = [
    "당신은 한국어 상황극 대화의 인물 정체성과 구조적 관계를 추출하는 전문가다.",
    "아래 작업 순서를 내부적으로 따르되 분석 과정이나 생각은 출력하지 말고 최종 JSON만 출력한다.",
    "1) 인물 식별: 대화에서 실제 인물로 등장하거나 한 번이라도 이름으로 언급된 모든 인물을 찾는다.",
    "2) 호칭 통합: 같은 인물의 이름, 성/이름 축약, 직함, 애칭, 가족 호칭을 한 main_name 아래 aliases로 묶는다.",
    "3) 관계 정의: 직접 대화가 없어도 제3자 언급으로 확인되는 구조적 관계를 relationships에 기록한다.",
    "4) 검증: 기존 인물 레지스트리와 같은 인물은 반드시 기존 id와 main_name을 그대로 재사용한다.",
    "5) 출력: 지정된 JSON 스키마만 출력한다. 코드펜스, 설명, 분석문은 금지한다.",
    "",
    "중요 규칙:",
    "- relationships는 이름이 아니라 characters의 id로 연결한다.",
    "- 관계 방향은 'target_id가 source_id에게 relation에 해당한다'는 뜻이다. 예: source=아이, target=김철수, relation=아버지.",
    "- 형/누나/오빠/언니/선배/후배/대표님/주인님 같은 호칭은 동일 인물 통합과 가족·서열·직장 관계 판단에 활용한다.",
    "- 감정(공포, 호감, 분노, 경계)은 relation이 아니다. relation에는 가족·학교·직장·사회적 지위만 쓴다.",
    "- aliases에는 원문에 실제 등장한 표현만 쓴다. '너/당신/그/그녀/우리' 같은 문맥 의존 대명사는 aliases에 넣지 않는다.",
    "- 이름이 없는 역할 인물에게 새 이름을 지어내지 않는다. 이름 미상 노드도 만들지 않는다.",
    "- evidence는 반드시 원문에서 글자 그대로 복사한 짧은 구절이어야 한다.",
    "- 동일 인물을 여러 character로 쪼개지 말고, 서로 다른 인물을 같은 호칭만으로 합치지 않는다.",
    `기존 인물 레지스트리: ${JSON.stringify(registry)}`,
  ].join("\n");
  const user = [
    `${params.windowStartTurn}~${params.windowEndTurn}턴에서 인물·호칭·관계를 추출하라.`,
    "이름이 한 번만 등장해도 실제 인물임이 분명하면 누락하지 않는다.",
    "",
    raw,
  ].join("\n");

  let parsed: StructuredGraphResponseShape | null = null;
  try {
    const response = await generateText({
      system,
      user,
      opts: {
        ...params.llmOpts,
        temperature: 0.1,
        topP: 0.9,
        responseMimeType: "application/json",
        responseJsonSchema: STRUCTURED_GRAPH_SCHEMA,
      },
    });
    const value = extractJsonObject(String(response?.text || ""));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as StructuredGraphResponseShape;
    } else {
      return { ok: false, characters: [], relationships: [] };
    }
  } catch {
    return { ok: false, characters: [], relationships: [] };
  }
  if (!parsed) {
    return { ok: false, characters: [], relationships: [] };
  }

  const existingById = new Map(existing.map((item) => [item.id, item]));
  const existingByName = new Map(
    existing.map((item) => [normalizedKey(item.mainName), item])
  );
  const existingAliasOwners = new Map<string, ExistingStructuredCharacter[]>();
  for (const item of existing) {
    for (const alias of item.aliases) {
      const key = normalizedKey(alias);
      const owners = existingAliasOwners.get(key) || [];
      owners.push(item);
      existingAliasOwners.set(key, owners);
    }
  }

  const outputIdToCharacter = new Map<string, StructuredCharacter>();
  const charactersByName = new Map<string, StructuredCharacter>();
  const addCharacter = (character: StructuredCharacter, outputId = character.id) => {
    const key = normalizedKey(character.mainName);
    const previous = charactersByName.get(key);
    if (previous) {
      previous.aliases = [...new Set([...previous.aliases, ...character.aliases])].slice(0, 20);
      if (!previous.profile && character.profile) previous.profile = character.profile;
      if (!previous.evidence && character.evidence) previous.evidence = character.evidence;
      outputIdToCharacter.set(outputId, previous);
      return previous;
    }
    charactersByName.set(key, character);
    outputIdToCharacter.set(outputId, character);
    return character;
  };

  const rawCharacters = Array.isArray(parsed?.characters) ? parsed.characters : [];
  for (let index = 0; index < rawCharacters.length; index += 1) {
    const item = rawCharacters[index];
    const outputId = cleanText(item?.id, 120) || `new_${index + 1}`;
    const proposedName = cleanText(item?.main_name, 80);
    const evidence = exactEvidence(raw, item?.evidence);
    const byAlias = existingAliasOwners.get(normalizedKey(proposedName)) || [];
    const known =
      existingById.get(outputId) ||
      existingByName.get(normalizedKey(proposedName)) ||
      (byAlias.length === 1 ? byAlias[0] : undefined);
    const isPersona =
      outputId === "persona" ||
      Boolean(personaName && normalizedKey(proposedName) === normalizedKey(personaName));
    const mainName = isPersona ? personaName : known?.mainName || proposedName;
    if (
      !mainName ||
      (!isPersona &&
        !known &&
        (!PERSON_NAME_PATTERN.test(mainName) ||
          NON_CHARACTER_NAMES.has(mainName) || ROLE_LIKE_NAME_PATTERN.test(mainName))) ||
      !evidence ||
      (!known &&
        !isPersona &&
        !raw.includes(mainName))
    ) {
      continue;
    }
    addCharacter(
      {
        id: isPersona ? "persona" : known?.id || outputId,
        mainName,
        aliases: safeAliases(raw, mainName, item?.aliases),
        profile: cleanText(item?.profile, 300),
        evidence,
      },
      outputId
    );
  }

  const resolveKnownCharacter = (idRaw: unknown) => {
    const id = cleanText(idRaw, 120);
    const output = outputIdToCharacter.get(id);
    if (output) return output;
    if (id === "persona" && personaName) {
      return addCharacter({
        id: "persona",
        mainName: personaName,
        aliases: [],
        profile: "",
        evidence: "",
      });
    }
    const known = existingById.get(id);
    if (!known) return null;
    return addCharacter({
      id: known.id,
      mainName: known.mainName,
      aliases: [],
      profile: "",
      evidence: "",
    });
  };

  const relationships: StructuredRelationship[] = [];
  const relationKeys = new Set<string>();
  const rawRelationships = Array.isArray(parsed?.relationships)
    ? parsed.relationships
    : [];
  for (const item of rawRelationships) {
    const source = resolveKnownCharacter(item?.source_id);
    const target = resolveKnownCharacter(item?.target_id);
    const relation = cleanText(item?.relation, 40);
    const evidence = exactEvidence(raw, item?.evidence);
    if (
      !source ||
      !target ||
      source.mainName === target.mainName ||
      !RELATION_TYPE_SET.has(relation) ||
      !evidence
    ) {
      continue;
    }
    const key = [
      normalizedKey(source.mainName),
      relation,
      normalizedKey(target.mainName),
    ].join("\u0000");
    if (relationKeys.has(key)) continue;
    relationKeys.add(key);
    relationships.push({
      sourceId: source.id,
      targetId: target.id,
      sourceName: source.mainName,
      targetName: target.mainName,
      relation,
      details: cleanText(item?.details, 500),
      evidence,
    });
  }

  const characters = [...charactersByName.values()];
  const canonicalNames = new Set(characters.map((item) => normalizedKey(item.mainName)));
  const aliasOwners = new Map<string, Set<string>>();
  for (const character of characters) {
    for (const alias of character.aliases) {
      const key = normalizedKey(alias);
      const owners = aliasOwners.get(key) || new Set<string>();
      owners.add(normalizedKey(character.mainName));
      aliasOwners.set(key, owners);
    }
  }
  for (const character of characters) {
    character.aliases = character.aliases.filter((alias) => {
      const key = normalizedKey(alias);
      return !canonicalNames.has(key) && (aliasOwners.get(key)?.size || 0) === 1;
    });
  }

  return {
    ok: true,
    characters: characters.slice(0, 80),
    relationships: relationships.slice(0, 160),
  };
}

function stableNameKey(name: string, personaName: string) {
  const value = cleanText(name, 80);
  return value &&
    normalizedKey(value) === normalizedKey(personaName)
    ? "persona"
    : `name:${normalizedKey(value)}`;
}

export function applyStructuredCharacterGraph(params: {
  chatId: string;
  personaName: string;
  graph: StructuredCharacterGraph;
  turnNo: number;
}) {
  const chatId = cleanText(params.chatId, 120);
  const personaName = cleanText(params.personaName, 80);
  const turnNo = Math.max(0, Math.trunc(Number(params.turnNo || 0)));
  if (!chatId || !params.graph.ok) {
    return {
      charactersAdded: [] as string[],
      aliasesUpdated: [] as string[],
      relationshipsUpserted: 0,
    };
  }

  const now = Date.now();
  const rosterRows = db
    .prepare(
      `SELECT id, name, aliases
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0`
    )
    .all(chatId) as Array<{ id?: string; name?: string; aliases?: string }>;
  const existingById = new Map(
    rosterRows.map((row) => [cleanText(row?.id, 120), row])
  );
  const existingByName = new Map(
    rosterRows.map((row) => [normalizedKey(row?.name), row])
  );
  const incomingByName = new Map(
    params.graph.characters
      .filter(
        (item) =>
          item.id !== "persona" &&
          normalizedKey(item.mainName) !== normalizedKey(personaName)
      )
      .map((item) => [normalizedKey(item.mainName), item])
  );

  const aliasOwners = new Map<string, Set<string>>();
  const registerAlias = (owner: string, alias: string) => {
    const key = normalizedKey(alias);
    if (!key) return;
    const owners = aliasOwners.get(key) || new Set<string>();
    owners.add(owner);
    aliasOwners.set(key, owners);
  };
  for (const row of rosterRows) {
    const owner = normalizedKey(row?.name);
    for (const alias of splitStoredCharacterAliases(
      decryptIfPossible(String(row?.aliases || ""))
    )) {
      registerAlias(owner, alias);
    }
  }
  for (const [owner, item] of incomingByName) {
    for (const alias of item.aliases) registerAlias(owner, alias);
  }
  const canonicalNames = new Set([
    ...rosterRows.map((row) => normalizedKey(row?.name)),
    ...incomingByName.keys(),
  ]);
  const validAliases = (owner: string, aliases: string[]) =>
    [...new Set(aliases)].filter((alias) => {
      const key = normalizedKey(alias);
      return (
        key &&
        !canonicalNames.has(key) &&
        (aliasOwners.get(key)?.size || 0) === 1 &&
        aliasOwners.get(key)?.has(owner)
      );
    });

  const charactersAdded: string[] = [];
  const aliasesUpdated: string[] = [];
  const insertCharacter = db.prepare(
    `INSERT INTO chat_character_roster
       (id, chatId, name, aliases, role, profile, relationshipNote, emotionNote,
        status, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(chatId, name) DO NOTHING`
  );
  const updateAliases = db.prepare(
    `UPDATE chat_character_roster
     SET aliases=?, updatedAt=?
     WHERE id=? AND chatId=?`
  );
  const applyCharacters = db.transaction(() => {
    for (const row of rosterRows) {
      const owner = normalizedKey(row?.name);
      const incoming = incomingByName.get(owner);
      const previous = splitStoredCharacterAliases(
        decryptIfPossible(String(row?.aliases || ""))
      );
      const next = validAliases(owner, [
        ...previous,
        ...(incoming?.aliases || []),
      ]);
      if (previous.join("\u0000") === next.join("\u0000")) continue;
      updateAliases.run(
        encryptIfPossible(next.join(", ")),
        now,
        cleanText(row?.id, 120),
        chatId
      );
      aliasesUpdated.push(cleanText(row?.name, 80));
    }

    for (const [owner, character] of incomingByName) {
      const existing =
        existingById.get(character.id) || existingByName.get(owner);
      if (existing) continue;
      const aliases = validAliases(owner, character.aliases);
      const result = insertCharacter.run(
        randomUUID(),
        chatId,
        character.mainName,
        encryptIfPossible(aliases.join(", ")),
        encryptIfPossible(""),
        encryptIfPossible(
          character.profile
            ? `(자동 탐지) ${character.profile}`
            : "(자동 탐지)"
        ),
        encryptIfPossible(""),
        encryptIfPossible(""),
        encryptIfPossible(""),
        now,
        now
      );
      if (Number(result.changes || 0) > 0) {
        charactersAdded.push(character.mainName);
        if (aliases.length) aliasesUpdated.push(character.mainName);
      }
    }
  });
  applyCharacters();

  const findExistingRelation = db.prepare(
    `SELECT id, firstSeenTurn
     FROM chat_character_relations
     WHERE chatId=? AND subjectKey=? AND relation=? AND objectKey=?
     ORDER BY CASE WHEN slotKey LIKE 'structured:%' THEN 1 ELSE 0 END, updatedAt DESC
     LIMIT 1`
  );
  const updateRelation = db.prepare(
    `UPDATE chat_character_relations
     SET subjectName=?, objectName=?, objectRole=?,
         sourceOrder=MAX(sourceOrder, ?),
         lastSeenTurn=MAX(lastSeenTurn, ?),
         updatedAt=?
     WHERE id=? AND chatId=?`
  );
  const insertRelation = db.prepare(
    `INSERT INTO chat_character_relations
       (id, chatId, subjectKey, subjectName, relation, slotKey, objectKey,
        objectName, objectRole, sourceOrder, firstSeenTurn, lastSeenTurn,
        createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chatId, subjectKey, relation, slotKey) DO UPDATE SET
       subjectName=excluded.subjectName,
       objectKey=excluded.objectKey,
       objectName=excluded.objectName,
       objectRole=excluded.objectRole,
       sourceOrder=MAX(chat_character_relations.sourceOrder, excluded.sourceOrder),
       lastSeenTurn=MAX(chat_character_relations.lastSeenTurn, excluded.lastSeenTurn),
       updatedAt=excluded.updatedAt`
  );
  let relationshipsUpserted = 0;
  const applyRelationships = db.transaction(() => {
    for (const relationship of params.graph.relationships) {
      const subjectName = cleanText(relationship.sourceName, 80);
      const objectName = cleanText(relationship.targetName, 80);
      const relation = cleanText(relationship.relation, 40);
      if (!subjectName || !objectName || !RELATION_TYPE_SET.has(relation)) {
        continue;
      }
      const subjectKey = stableNameKey(subjectName, personaName);
      const objectKey = stableNameKey(objectName, personaName);
      if (!subjectKey || !objectKey || subjectKey === objectKey) continue;
      const details =
        cleanText(relationship.details, 500) ||
        `${subjectName}에게 ${objectName}은(는) ${relation}`;
      const existingRelation = findExistingRelation.get(
        chatId,
        subjectKey,
        relation,
        objectKey
      ) as { id?: string; firstSeenTurn?: number } | undefined;
      if (existingRelation?.id) {
        updateRelation.run(
          subjectName,
          objectName,
          details,
          turnNo,
          turnNo,
          now,
          existingRelation.id,
          chatId
        );
      } else {
        insertRelation.run(
          randomUUID(),
          chatId,
          subjectKey,
          subjectName,
          relation,
          cleanText(`structured:${objectKey}`, 80),
          objectKey,
          objectName,
          details,
          turnNo,
          turnNo,
          turnNo,
          now,
          now
        );
      }
      relationshipsUpserted += 1;
    }
  });
  applyRelationships();

  return {
    charactersAdded: [...new Set(charactersAdded)],
    aliasesUpdated: [...new Set(aliasesUpdated)],
    relationshipsUpserted,
  };
}
