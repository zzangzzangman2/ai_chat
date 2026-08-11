import { randomUUID } from "crypto";

import { generateText } from "@/lib/ai";
import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { db } from "@/lib/db";
import {
  inferCharacterOccupation,
  isValidDescriptiveRelationship,
} from "@/lib/relationship_context";
import { parseRelationshipKnownBy } from "@/lib/character_knowledge";
import {
  CANONICAL_FACT_KEYS,
  canonicalFactConflictsWithPersona,
  storeCanonicalFactObservations,
  type AuthoritativePersonaFacts,
  type CanonicalFactKey,
  type CanonicalFactObservation,
  type ResolvedCanonicalFact,
} from "@/lib/canonical_character_facts";

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
  job: string;
  role: string;
  profile: string;
  relationshipNote: string;
  recentMemory: string;
};

export type StructuredCharacter = {
  id: string;
  mainName: string;
  aliases: string[];
  profile: string;
  job: string;
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
  knownByNames: string[];
  knowledgeEvidence: string;
};

export type StructuredCharacterFact = CanonicalFactObservation;

export type StructuredCharacterGraph = {
  ok: boolean;
  characters: StructuredCharacter[];
  relationships: StructuredRelationship[];
  facts: StructuredCharacterFact[];
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
      `SELECT r.id, r.name, r.aliases, r.role, r.profile, r.relationshipNote,
              COALESCE((SELECT m.summary
                FROM chat_character_turn_memories m
                WHERE m.chatId=r.chatId AND m.rosterId=r.id
                ORDER BY m.turnNo DESC LIMIT 1), '') AS latestMemorySummary,
              COALESCE((SELECT m.evidence
                FROM chat_character_turn_memories m
                WHERE m.chatId=r.chatId AND m.rosterId=r.id
                ORDER BY m.turnNo DESC LIMIT 1), '') AS latestMemoryEvidence
       FROM chat_character_roster r
       WHERE chatId=? AND enabled != 0
       ORDER BY updatedAt DESC, name ASC
       LIMIT 80`
    ).all(chatId) as Array<Record<string, unknown>>;
  return rows
    .map((row) => {
      const role = cleanText(decryptIfPossible(String(row?.role || "")), 500);
      const profile = cleanText(decryptIfPossible(String(row?.profile || "")), 1600);
      const relationshipNote = cleanText(
        decryptIfPossible(String(row?.relationshipNote || "")),
        1000
      );
      const recentMemory = cleanText(
        [
          decryptIfPossible(String(row?.latestMemorySummary || "")),
          decryptIfPossible(String(row?.latestMemoryEvidence || "")),
        ]
          .filter(Boolean)
          .join(" / "),
        800
      );
      return {
        id: cleanText(row?.id, 120),
        mainName: cleanText(row?.name, 80),
        aliases: splitStoredCharacterAliases(
          decryptIfPossible(String(row?.aliases || ""))
        ),
        job: inferCharacterOccupation(role, profile),
        role,
        profile,
        relationshipNote,
        recentMemory,
      };
    })
    .filter((row) => row.id && row.mainName);
}

const STRUCTURED_GRAPH_SCHEMA = {
  type: "object",
  required: ["characters", "relationships", "facts"],
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "main_name", "aliases", "profile", "job", "evidence"],
        properties: {
          id: { type: "string" },
          main_name: { type: "string" },
          aliases: {
            type: "array",
            items: { type: "string" },
          },
          profile: { type: "string" },
          job: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    relationships: {
      type: "array",
      items: {
        type: "object",
        required: [
          "source_id",
          "target_id",
          "relation",
          "details",
          "evidence",
          "known_by_ids",
          "knowledge_evidence",
        ],
        properties: {
          source_id: { type: "string" },
          target_id: { type: "string" },
          relation: { type: "string" },
          details: { type: "string" },
          evidence: { type: "string" },
          known_by_ids: {
            type: "array",
            items: { type: "string" },
          },
          knowledge_evidence: { type: "string" },
        },
      },
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        required: [
          "subject_id",
          "category",
          "fact_key",
          "value",
          "evidence",
          "source_role",
          "confidence",
          "stable",
        ],
        properties: {
          subject_id: { type: "string" },
          category: { type: "string" },
          fact_key: {
            type: "string",
            enum: CANONICAL_FACT_KEYS,
          },
          value: { type: "string" },
          evidence: { type: "string" },
          source_role: {
            type: "string",
            enum: ["user", "assistant"],
          },
          confidence: { type: "integer" },
          stable: { type: "boolean" },
        },
      },
    },
  },
} as const;

type StructuredGraphResponseShape = {
  characters?: unknown;
  relationships?: unknown;
  facts?: unknown;
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

function evidenceSourceRole(raw: string, evidence: string) {
  const roles = new Set<"user" | "assistant">();
  let from = 0;
  while (from < raw.length) {
    const index = raw.indexOf(evidence, from);
    if (index < 0) break;
    const prefix = raw.slice(0, index);
    const userAt = prefix.lastIndexOf("[사용자]");
    const assistantAt = prefix.lastIndexOf("[어시스턴트]");
    roles.add(userAt > assistantAt ? "user" : "assistant");
    from = index + Math.max(1, evidence.length);
  }
  if (roles.size !== 1) return "";
  return [...roles][0];
}

function safeAliases(
  raw: string,
  mainName: string,
  values: unknown,
  evidence: string
) {
  if (!Array.isArray(values)) return [] as string[];
  const aliases = new Set<string>();
  for (const value of values) {
    const alias = cleanText(value, 80);
    if (
      !alias ||
      normalizedKey(alias) === normalizedKey(mainName) ||
      NON_PERSISTENT_ALIASES.has(alias) ||
      !raw.includes(alias) ||
      !evidence.includes(mainName) ||
      !evidence.includes(alias)
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
  existingFacts?: ResolvedCanonicalFact[];
  authoritativePersona?: AuthoritativePersonaFacts;
  llmOpts: {
    model: string;
    maxOutputTokens: number;
    maxReasoningTokens: number;
    thinkingBudget: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  };
  windowStartTurn: number;
  windowEndTurn: number;
}): Promise<StructuredCharacterGraph> {
  const raw = String(params.rawWindowText || "").trim();
  if (!raw || raw.length < 40) {
    return { ok: true, characters: [], relationships: [], facts: [] };
  }

  const personaName = cleanText(params.personaName, 80);
  const existing = params.existingCharacters.slice(0, 80);
  const existingFacts = (params.existingFacts || []).slice(0, 240);
  const registry = [
    ...(personaName
      ? [{
          id: "persona",
          main_name: personaName,
          aliases: ["주인공", "페르소나"],
          profile: {
            authoritative_setting: params.authoritativePersona || {},
            canonical_facts: existingFacts
              .filter(
                (fact) =>
                  fact.subjectKey === "persona" ||
                  normalizedKey(fact.subjectName) === normalizedKey(personaName)
              )
              .map((fact) => ({ key: fact.factKey, value: fact.value, source: fact.sourceRole })),
          },
        }]
      : []),
    ...existing.map((item) => ({
      id: item.id,
      main_name: item.mainName,
      aliases: item.aliases,
      profile: {
        job: item.job,
        role: item.role,
        background: item.profile,
        relationship_memory: item.relationshipNote,
        recent_individual_memory: item.recentMemory,
        canonical_facts: existingFacts
          .filter(
            (fact) =>
              fact.subjectKey === item.id ||
              normalizedKey(fact.subjectName) === normalizedKey(item.mainName)
          )
          .map((fact) => ({ key: fact.factKey, value: fact.value, source: fact.sourceRole })),
      },
    })),
  ];
  const system = [
    "당신은 한국어 상황극 대화의 인물 정체성과 구조적 관계를 추출하는 전문가다.",
    "아래 작업 순서를 내부적으로 따르되 분석 과정이나 생각은 출력하지 말고 최종 JSON만 출력한다.",
    "1) 인물 식별: 대화에서 실제 인물로 등장하거나 한 번이라도 이름으로 언급된 모든 인물을 찾는다.",
    "2) 호칭 통합: 같은 인물의 이름, 성/이름 축약, 직함, 애칭, 가족 호칭을 한 main_name 아래 aliases로 묶는다.",
    "3) 직업·배경·기억 결합: 대화뿐 아니라 기존 레지스트리의 job, role, background, relationship_memory, recent_individual_memory를 함께 보고 관계를 추론한다.",
    "4) 관계 정의: 직접 대화가 없어도 제3자 언급, 직업, 배경 상황으로 확인되는 관계를 relationships에 기록한다.",
    "5) 지식 범위: 관계 사실을 직접 목격·경험했거나 명시적으로 전달받아 실제로 아는 인물만 known_by_ids에 기록한다.",
    "6) 정본 사실 추출: 인물마다 다음 대화에서도 유지되어야 할 나이·성별·키·체중·체형·외모·직업·배경·정체·말투·거주지만 facts에 구조화한다.",
    "7) 검증: 기존 인물 레지스트리와 같은 인물은 반드시 기존 id와 main_name을 그대로 재사용한다.",
    "8) 출력: 지정된 JSON 스키마만 출력한다. 코드펜스, 설명, 분석문은 금지한다.",
    "",
    "중요 규칙:",
    "- relationships는 이름이 아니라 characters의 id로 연결한다.",
    "- 관계 방향은 'target_id가 source_id에게 relation에 해당한다'는 뜻이다. 예: source=아이, target=김철수, relation=아버지.",
    "- 형/누나/오빠/언니/선배/후배/대표님/주인님 같은 호칭은 동일 인물 통합과 가족·서열·직장 관계 판단에 활용한다.",
    "- 관계는 고정 설정이 아니다. 최신 대화에서 관계가 발전하거나 깨졌다면 초기 직업·초면 관계보다 최신 상태를 우선한다.",
    "- known_by_ids는 관계의 양 끝 인물 목록이 아니다. 각 인물이 그 관계의 구체적 사실을 안다는 원문 근거가 있을 때만 넣는다.",
    "- 현장에 없었거나 잠들었거나 보지 못했거나, 복면·변장 때문에 정체를 확인하지 못한 인물은 known_by_ids에 넣지 않는다.",
    "- 전지적 지문이 범인·배후·비밀 정체를 확정해도 그 사실을 목격하거나 전달받지 못한 다른 인물은 알지 못한다.",
    "- 어시스턴트 지문이 정보 획득 장면 없이 인물의 앎을 단정한 문장만으로는 known_by_ids를 새로 만들지 않는다. 실제 목격·경험·정보 전달 장면이 evidence에 있어야 한다.",
    "- 가족·직장·친구처럼 당사자들이 통상 서로 아는 공개 관계는 양쪽 인물을 known_by_ids에 넣을 수 있다.",
    "- knowledge_evidence는 known_by_ids의 인물들이 해당 사실을 목격·경험·전달받았음을 증명하는 원문의 짧은 구절을 그대로 복사한다. 그런 근거가 없으면 known_by_ids=[]와 knowledge_evidence=\"\"를 쓴다.",
    "- 예: '아이돌과 경비원'이 사귀기 시작하면 '연인', 결혼하면 '배우자', 이혼하면 '이혼한 전 배우자'로 갱신한다.",
    "- 각 character의 job에는 대화와 배경에서 확인되는 직업만 간결하게 기록한다. 확인되지 않으면 빈 문자열을 쓴다.",
    "- relation에 '미확인', '알 수 없음', '관계 미정', '중립'을 쓰는 것은 엄격히 금지한다.",
    "- 명확한 가족·학교·직장 관계가 없으면 '아이돌과 소속사 경비원', '이제 막 통성명을 한 초면', '현재 사건으로 얽힌 당사자'처럼 직업과 현재 상황을 조합한 서술형 관계를 쓴다.",
    "- 감정(공포, 호감, 분노, 경계)은 relation이 아니다. 감정은 details에만 쓰고 relation에는 가족·학교·직장·사회적 지위 또는 현재 상황 관계를 쓴다.",
    "- aliases에는 원문에 실제 등장한 표현만 쓴다. '너/당신/그/그녀/우리' 같은 문맥 의존 대명사는 aliases에 넣지 않는다.",
    "- aliases는 evidence 한 구절 안에 main_name과 alias가 함께 있어 동일 인물임이 직접 증명될 때만 넣는다. 근거가 분리되거나 추측이면 aliases를 비운다.",
    "- 이름이 없는 역할 인물에게 새 이름을 지어내지 않는다. 이름 미상 노드도 만들지 않는다.",
    "- evidence는 반드시 원문에서 글자 그대로 복사한 짧은 구절이어야 한다.",
    "- 동일 인물을 여러 character로 쪼개지 말고, 서로 다른 인물을 같은 호칭만으로 합치지 않는다.",
    "- facts에는 일회성 자세·표정·옷차림·현재 위치·방문 장소·순간 감정·비유를 넣지 않는다. 여러 턴 뒤에도 유지될 정체성·신체·직업·배경·거주지 사실만 넣는다.",
    "- residence는 그 인물이 평소 사는 집·자택·거처만 뜻한다. 방문·잠입·숙박·현재 장면의 위치를 residence로 저장하지 않는다.",
    "- 'A의 아랫집/윗집'은 A의 거주지를 기준으로 한 별도 공간 관계다. 다른 인물의 집과 같은 건물이라고 사용자가 명시하지 않았다면 절대 합치지 않는다.",
    "- facts의 source_role은 근거 문장이 [사용자]면 user, [어시스턴트]면 assistant로 정확히 기록한다. 발화 내용이 아니라 원문 역할 태그를 따른다.",
    "- [사용자]가 직접 확정·정정한 사실은 기존 사실과 달라도 최신 값으로 추출한다.",
    "- 단, 등장인물의 대사 속 주장·욕설·질문·추측·거짓말은 사용자 태그에 있어도 정본 사실 근거가 아니다. OOC/설정/서술로 확정된 내용만 user 사실로 인정한다.",
    "- [어시스턴트] 지문은 새 NPC의 아직 없는 사실을 처음 세우는 근거로만 쓸 수 있다. 기존 정본 사실을 덮어쓰거나 모순시키는 AI 형용사·추측은 facts에 넣지 않는다.",
    "- 특히 키·체중 수치와 반대되는 체형 표현을 만들지 않는다. 기존 설정이 100kg 이상인 인물을 왜소한 몸집·마른 체구·가녀린 체격으로 추출하지 않는다.",
    "- 사실 근거는 반드시 한 개의 짧은 exact evidence로 직접 확인되어야 하며, 추론한 수치나 외형은 저장하지 않는다.",
    `페르소나 최우선 설정: ${JSON.stringify(params.authoritativePersona || {})}`,
    `기존 인물 레지스트리: ${JSON.stringify(registry)}`,
  ].join("\n");
  const user = [
    `${params.windowStartTurn}~${params.windowEndTurn}턴에서 인물·호칭·관계를 추출하라.`,
    "이름이 한 번만 등장해도 실제 인물임이 분명하면 누락하지 않는다.",
    "",
    raw,
  ].join("\n");

  let parsed: StructuredGraphResponseShape | null = null;
  let responseText = "";
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
    responseText = String(response?.text || "");
    const value = extractJsonObject(responseText);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as StructuredGraphResponseShape;
    } else {
      if (process.env.CHAT_DEBUG === "1") {
        console.log(JSON.stringify({
          tag: "structuredGraph.parse_failed",
          window: [params.windowStartTurn, params.windowEndTurn],
          rawTextSample: responseText.slice(0, 1200),
        }));
      }
      return { ok: false, characters: [], relationships: [], facts: [] };
    }
  } catch (error: unknown) {
    if (process.env.CHAT_DEBUG === "1") {
      console.log(JSON.stringify({
        tag: "structuredGraph.llm_error",
        window: [params.windowStartTurn, params.windowEndTurn],
        error: String((error as { message?: unknown })?.message || error),
      }));
    }
    return { ok: false, characters: [], relationships: [], facts: [] };
  }
  if (!parsed) {
    return { ok: false, characters: [], relationships: [], facts: [] };
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
  const characterRejects: Array<{ name: string; reason: string }> = [];
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
    let rejectReason = "";
    if (!mainName) {
      rejectReason = "empty_name";
    } else if (
      !isPersona &&
      !known &&
      !PERSON_NAME_PATTERN.test(mainName)
    ) {
      rejectReason = "invalid_name_pattern";
    } else if (!isPersona && !known && NON_CHARACTER_NAMES.has(mainName)) {
      rejectReason = "generic_role_name";
    } else if (!isPersona && !known && ROLE_LIKE_NAME_PATTERN.test(mainName)) {
      rejectReason = "role_like_name";
    } else if (!evidence) {
      rejectReason = "evidence_not_exact";
    } else if (!known && !isPersona && !raw.includes(mainName)) {
      rejectReason = "name_not_in_source";
    }
    if (rejectReason) {
      characterRejects.push({ name: mainName || proposedName, reason: rejectReason });
      continue;
    }
    addCharacter(
      {
        id: isPersona ? "persona" : known?.id || outputId,
        mainName,
        aliases: safeAliases(raw, mainName, item?.aliases, evidence),
        profile: cleanText(item?.profile, 300),
        job: inferCharacterOccupation(item?.job, item?.profile),
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
        job: "",
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
      job: known.job,
      evidence: "",
    });
  };

  const relationships: StructuredRelationship[] = [];
  let rejectedRelationshipCount = 0;
  const relationKeys = new Set<string>();
  const rawRelationships = Array.isArray(parsed?.relationships)
    ? parsed.relationships
    : [];
  for (const item of rawRelationships) {
    const source = resolveKnownCharacter(item?.source_id);
    const target = resolveKnownCharacter(item?.target_id);
    const relation = cleanText(item?.relation, 40);
    const evidence = exactEvidence(raw, item?.evidence);
    const knowledgeEvidence = exactEvidence(raw, item?.knowledge_evidence);
    const knownByNames: string[] = [];
    if (knowledgeEvidence && Array.isArray(item?.known_by_ids)) {
      const seenKnownNames = new Set<string>();
      for (const id of item.known_by_ids as unknown[]) {
        const name = cleanText(resolveKnownCharacter(id)?.mainName, 80);
        if (!name || seenKnownNames.has(name)) continue;
        seenKnownNames.add(name);
        knownByNames.push(name);
        if (knownByNames.length >= 40) break;
      }
    }
    if (
      !source ||
      !target ||
      source.mainName === target.mainName ||
      (!RELATION_TYPE_SET.has(relation) && !isValidDescriptiveRelationship(relation)) ||
      !evidence
    ) {
      rejectedRelationshipCount += 1;
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
      knownByNames,
      knowledgeEvidence,
    });
  }

  const facts: StructuredCharacterFact[] = [];
  const factSlots = new Map<string, number>();
  let rejectedFactCount = 0;
  const rawFacts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  for (const item of rawFacts) {
    const subject = resolveKnownCharacter(item?.subject_id);
    const factKey = cleanText(item?.fact_key, 40) as CanonicalFactKey;
    const value = cleanText(item?.value, 800);
    const evidence = exactEvidence(raw, item?.evidence);
    const sourceRole = evidence ? evidenceSourceRole(raw, evidence) : "";
    const declaredSourceRole = cleanText(item?.source_role, 20);
    const confidence = Math.max(0, Math.min(100, Math.trunc(Number(item?.confidence) || 0)));
    const stable = item?.stable === true;
    if (
      !subject ||
      !CANONICAL_FACT_KEYS.includes(factKey) ||
      !value ||
      !evidence ||
      !sourceRole ||
      declaredSourceRole !== sourceRole ||
      !stable ||
      confidence < 60
    ) {
      rejectedFactCount += 1;
      continue;
    }

    const fact: StructuredCharacterFact = {
      subjectKey: subject.id === "persona" ? "persona" : subject.id,
      subjectName: subject.mainName,
      category: cleanText(item?.category, 40) || "identity",
      factKey,
      value,
      evidence,
      sourceRole,
      confidence,
      turnNo: params.windowEndTurn,
    };
    const existingSameKey = existingFacts.filter(
      (known) =>
        (known.subjectKey === fact.subjectKey ||
          normalizedKey(known.subjectName) === normalizedKey(fact.subjectName)) &&
        known.factKey === fact.factKey
    );
    if (
      sourceRole === "assistant" &&
      (canonicalFactConflictsWithPersona(
        fact,
        params.authoritativePersona || {
          name: personaName,
          age: 0,
          gender: "",
          info: "",
          heightCm: null,
          weightKg: null,
        }
      ) ||
        existingSameKey.some(
          (known) => normalizedKey(known.value) !== normalizedKey(fact.value)
        ))
    ) {
      rejectedFactCount += 1;
      continue;
    }
    const factSlot = [fact.subjectKey, fact.factKey].join("\u0000");
    const previousIndex = factSlots.get(factSlot);
    if (previousIndex !== undefined) {
      if (sourceRole === "user") facts[previousIndex] = fact;
      continue;
    }
    factSlots.set(factSlot, facts.length);
    facts.push(fact);
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

  if (process.env.CHAT_DEBUG === "1") {
    console.log(JSON.stringify({
      tag: "structuredGraph.result",
      window: [params.windowStartTurn, params.windowEndTurn],
      rawTextSample: responseText.slice(0, 1200),
      rawCharacterCount: rawCharacters.length,
      acceptedCharacters: characters.map((item) => item.mainName),
      rejectedCharacters: characterRejects.slice(0, 30),
      rawRelationshipCount: rawRelationships.length,
      acceptedRelationshipCount: relationships.length,
      rejectedRelationshipCount,
      rawFactCount: rawFacts.length,
      acceptedFactCount: facts.length,
      rejectedFactCount,
    }));
  }

  return {
    ok: true,
    characters: characters.slice(0, 80),
    relationships: relationships.slice(0, 160),
    facts: facts.slice(0, 240),
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
      factsUpserted: 0,
    };
  }

  const now = Date.now();
  const rosterRows = db
    .prepare(
      `SELECT id, name, aliases, role, profile
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0`
    )
    .all(chatId) as Array<Record<string, unknown>>;
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
  const updateExistingCharacter = db.prepare(
    `UPDATE chat_character_roster
     SET aliases=?, role=?, profile=?, updatedAt=?
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
      const currentRole = cleanText(
        decryptIfPossible(String(row?.role || "")),
        500
      );
      const currentProfile = cleanText(
        decryptIfPossible(String(row?.profile || "")),
        2000
      );
      const nextRole = currentRole || incoming?.job || "";
      const nextProfile =
        currentProfile ||
        (incoming?.profile ? `(자동 탐지) ${incoming.profile}` : "");
      const aliasesChanged = previous.join("\u0000") !== next.join("\u0000");
      const factsChanged = nextRole !== currentRole || nextProfile !== currentProfile;
      if (!aliasesChanged && !factsChanged) continue;
      updateExistingCharacter.run(
        encryptIfPossible(next.join(", ")),
        encryptIfPossible(nextRole),
        encryptIfPossible(nextProfile),
        now,
        cleanText(row?.id, 120),
        chatId
      );
      if (aliasesChanged) aliasesUpdated.push(cleanText(row?.name, 80));
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
        encryptIfPossible(character.job),
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
    `SELECT id, firstSeenTurn, knownBy, knowledgeEvidence
     FROM chat_character_relations
     WHERE chatId=? AND subjectKey=? AND relation=? AND objectKey=?
     ORDER BY CASE WHEN slotKey LIKE 'structured:%' THEN 1 ELSE 0 END, updatedAt DESC
     LIMIT 1`
  );
  const updateRelation = db.prepare(
    `UPDATE chat_character_relations
     SET subjectName=?, objectName=?, objectRole=?, knownBy=?, knowledgeEvidence=?,
          sourceOrder=MAX(sourceOrder, ?),
         lastSeenTurn=MAX(lastSeenTurn, ?),
         updatedAt=?
     WHERE id=? AND chatId=?`
  );
  const insertRelation = db.prepare(
    `INSERT INTO chat_character_relations
       (id, chatId, subjectKey, subjectName, relation, slotKey, objectKey,
         objectName, objectRole, knownBy, knowledgeEvidence, sourceOrder,
         firstSeenTurn, lastSeenTurn, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chatId, subjectKey, relation, slotKey) DO UPDATE SET
       subjectName=excluded.subjectName,
       objectKey=excluded.objectKey,
       objectName=excluded.objectName,
       objectRole=excluded.objectRole,
       knownBy=CASE
         WHEN excluded.knownBy <> '[]' THEN excluded.knownBy
         ELSE chat_character_relations.knownBy
       END,
       knowledgeEvidence=CASE
         WHEN excluded.knowledgeEvidence <> '' THEN excluded.knowledgeEvidence
         ELSE chat_character_relations.knowledgeEvidence
       END,
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
      if (
        !subjectName ||
        !objectName ||
        (!RELATION_TYPE_SET.has(relation) && !isValidDescriptiveRelationship(relation))
      ) {
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
      ) as {
        id?: string;
        firstSeenTurn?: number;
        knownBy?: string;
        knowledgeEvidence?: string;
      } | undefined;
      const knownByNames = [
        ...new Set([
          ...parseRelationshipKnownBy(existingRelation?.knownBy),
          ...(relationship.knownByNames || []).map((name) => cleanText(name, 80)),
        ].filter(Boolean)),
      ].slice(0, 40);
      const knownBy = JSON.stringify(knownByNames);
      const knowledgeEvidence =
        cleanText(relationship.knowledgeEvidence, 500) ||
        cleanText(existingRelation?.knowledgeEvidence, 500);
      if (existingRelation?.id) {
        updateRelation.run(
          subjectName,
          objectName,
          details,
          knownBy,
          knowledgeEvidence,
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
          knownBy,
          knowledgeEvidence,
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

  const factsUpserted = storeCanonicalFactObservations({
    chatId,
    facts: params.graph.facts,
  });

  return {
    charactersAdded: [...new Set(charactersAdded)],
    aliasesUpdated: [...new Set(aliasesUpdated)],
    relationshipsUpserted,
    factsUpserted,
  };
}
