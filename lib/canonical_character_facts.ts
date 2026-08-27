import { createHash, randomUUID } from "crypto";

import { decryptIfPossible, encryptIfPossible } from "@/lib/crypto";
import { db } from "@/lib/db";
import { resolveCanonicalFactCandidate } from "@/lib/canonical_fact_resolution";

export const CANONICAL_FACT_KEYS = [
  "age",
  "gender",
  "height",
  "weight",
  "body_build",
  "appearance",
  "occupation",
  "background",
  "identity",
  "speech_style",
  "residence",
] as const;

export type CanonicalFactKey = (typeof CANONICAL_FACT_KEYS)[number];
export type CanonicalFactSourceRole = "user" | "assistant";

export type CanonicalFactObservation = {
  subjectKey: string;
  subjectName: string;
  category: string;
  factKey: CanonicalFactKey;
  value: string;
  evidence: string;
  sourceRole: CanonicalFactSourceRole;
  confidence: number;
  turnNo: number;
};

export type ResolvedCanonicalFact = CanonicalFactObservation & {
  id: string;
  authority: number;
};

export type AuthoritativePersonaFacts = {
  name: string;
  age: number;
  gender: string;
  info: string;
  heightCm: number | null;
  weightKg: number | null;
};

const PHYSICAL_DESCRIPTOR_RE =
  /(?:왜소(?:한)?|가냘픈|가녀린|호리호리한|마른|깡마른|거구(?:의)?|육중한|우람한|비대한)\s*(?:몸집|체구|몸|체격)?/gu;
const SMALL_BUILD_RE = /(?:왜소(?:한)?\s*(?:몸집|체구|몸|체격)|가냘픈\s*(?:몸집|체구|몸|체격)|가녀린\s*(?:몸집|체구|몸|체격)|호리호리한\s*(?:몸집|체구|몸|체격)|마른\s*(?:몸집|체구|몸|체격)|깡마른\s*(?:몸집|체구|몸|체격))/u;
const LARGE_BUILD_RE = /(?:거구(?:의)?|육중한\s*(?:몸집|체구|몸|체격)|우람한\s*(?:몸집|체구|몸|체격)|비대한\s*(?:몸집|체구|몸|체격))/u;

function cleanText(value: unknown, max = 800) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizedKey(value: unknown) {
  return cleanText(value, 120).toLocaleLowerCase("ko-KR");
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function extractMeasurement(text: string, kind: "height" | "weight") {
  const source = String(text || "");
  const pattern =
    kind === "height"
      ? /(\d{2,3}(?:\.\d+)?)\s*(?:cm|㎝|센티미터|센티)(?![가-힣A-Za-z])/iu
      : /(\d{2,3}(?:\.\d+)?)\s*(?:kg|㎏|킬로그램|킬로)(?![가-힣A-Za-z])/iu;
  const match = source.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (kind === "height" && (value < 40 || value > 260)) return null;
  if (kind === "weight" && (value < 2 || value > 500)) return null;
  return value;
}

export function buildAuthoritativePersonaFacts(params: {
  name?: unknown;
  age?: unknown;
  gender?: unknown;
  info?: unknown;
}): AuthoritativePersonaFacts {
  const info = cleanText(params.info, 5000);
  return {
    name: cleanText(params.name, 80),
    age: clampInt(params.age, 0, 999, 0),
    gender: cleanText(params.gender, 40),
    info,
    heightCm: extractMeasurement(info, "height"),
    weightKg: extractMeasurement(info, "weight"),
  };
}

export function canonicalFactConflictsWithPersona(
  fact: Pick<CanonicalFactObservation, "subjectKey" | "subjectName" | "factKey" | "value">,
  persona: AuthoritativePersonaFacts
) {
  const isPersona =
    fact.subjectKey === "persona" ||
    (persona.name && normalizedKey(fact.subjectName) === normalizedKey(persona.name));
  if (!isPersona) return false;

  const value = cleanText(fact.value, 500);
  if (fact.factKey === "age" && persona.age > 0) {
    const proposed = Number(value.match(/\d{1,3}/u)?.[0] || 0);
    return proposed > 0 && proposed !== persona.age;
  }
  if (fact.factKey === "gender" && persona.gender) {
    const proposed = normalizedKey(value);
    const canonical = normalizedKey(persona.gender);
    const normalizeGender = (gender: string) =>
      /^(?:남|남성|남자)$/u.test(gender)
        ? "남성"
        : /^(?:여|여성|여자)$/u.test(gender)
          ? "여성"
          : gender;
    return Boolean(proposed && normalizeGender(proposed) !== normalizeGender(canonical));
  }
  if (fact.factKey === "height" && persona.heightCm !== null) {
    const proposed = extractMeasurement(value, "height");
    return proposed !== null && Math.abs(proposed - persona.heightCm) > 0.01;
  }
  if (fact.factKey === "weight" && persona.weightKg !== null) {
    const proposed = extractMeasurement(value, "weight");
    return proposed !== null && Math.abs(proposed - persona.weightKg) > 0.01;
  }
  if (
    (fact.factKey === "body_build" || fact.factKey === "appearance") &&
    persona.weightKg !== null
  ) {
    if (persona.weightKg >= 100 && SMALL_BUILD_RE.test(value)) return true;
    if (persona.weightKg <= 45 && LARGE_BUILD_RE.test(value)) return true;
  }
  return false;
}

function factHash(fact: CanonicalFactObservation) {
  return createHash("sha256")
    .update(
      [
        normalizedKey(fact.subjectKey),
        fact.factKey,
        normalizedKey(fact.value),
        fact.sourceRole,
        String(fact.turnNo),
      ].join("\u0000")
    )
    .digest("hex");
}

export function storeCanonicalFactObservations(params: {
  chatId: string;
  facts: CanonicalFactObservation[];
}) {
  const chatId = cleanText(params.chatId, 120);
  if (!chatId || !params.facts.length) return 0;
  const now = Date.now();
  const insert = (() => {
    try {
      return db.prepare(
        `INSERT OR IGNORE INTO chat_character_facts
           (id, chatId, subjectKey, subjectName, category, factKey, factValue,
            factHash, sourceRole, authority, confidence, evidence, turnNo,
            createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
    } catch {
      return null;
    }
  })();
  if (!insert) return 0;
  let inserted = 0;
  const run = db.transaction((facts: CanonicalFactObservation[]) => {
    for (const raw of facts) {
      const subjectKey = cleanText(raw.subjectKey, 160);
      const subjectName = cleanText(raw.subjectName, 80);
      const factKey = cleanText(raw.factKey, 40) as CanonicalFactKey;
      const value = cleanText(raw.value, 800);
      const evidence = cleanText(raw.evidence, 800);
      const sourceRole: CanonicalFactSourceRole =
        raw.sourceRole === "user" ? "user" : "assistant";
      if (
        !subjectKey ||
        !subjectName ||
        !CANONICAL_FACT_KEYS.includes(factKey) ||
        !value ||
        !evidence
      ) {
        continue;
      }
      const fact: CanonicalFactObservation = {
        subjectKey,
        subjectName,
        category: cleanText(raw.category, 40) || "identity",
        factKey,
        value,
        evidence,
        sourceRole,
        confidence: clampInt(raw.confidence, 0, 100, 0),
        turnNo: Math.max(0, Math.trunc(Number(raw.turnNo) || 0)),
      };
      const authority = sourceRole === "user" ? 100 : 40;
      const result = insert.run(
        randomUUID(),
        chatId,
        fact.subjectKey,
        fact.subjectName,
        fact.category,
        fact.factKey,
        encryptIfPossible(fact.value),
        factHash(fact),
        fact.sourceRole,
        authority,
        fact.confidence,
        encryptIfPossible(fact.evidence),
        fact.turnNo,
        now,
        now
      );
      inserted += Number(result.changes || 0);
    }
  });
  run(params.facts);
  return inserted;
}

export function loadCanonicalCharacterFacts(chatIdRaw: string) {
  const chatId = cleanText(chatIdRaw, 120);
  if (!chatId) return [] as ResolvedCanonicalFact[];
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = db
      .prepare(
        `SELECT id, subjectKey, subjectName, category, factKey, factValue,
                sourceRole, authority, confidence, evidence, turnNo
         FROM chat_character_facts
         WHERE chatId=?
         ORDER BY turnNo ASC, createdAt ASC
         LIMIT 2400`
      )
      .all(chatId) as Array<Record<string, unknown>>;
  } catch {
    // A hot-reloaded development process can briefly retain the pre-migration
    // db module. Persona settings still produce a canon block until restart.
    return [] as ResolvedCanonicalFact[];
  }

  const groups = new Map<string, ResolvedCanonicalFact[]>();
  for (const row of rows) {
    const factKey = cleanText(row.factKey, 40) as CanonicalFactKey;
    const sourceRole: CanonicalFactSourceRole =
      row.sourceRole === "user" ? "user" : "assistant";
    const fact: ResolvedCanonicalFact = {
      id: cleanText(row.id, 120),
      subjectKey: cleanText(row.subjectKey, 160),
      subjectName: cleanText(row.subjectName, 80),
      category: cleanText(row.category, 40),
      factKey,
      value: cleanText(decryptIfPossible(String(row.factValue || "")), 800),
      evidence: cleanText(decryptIfPossible(String(row.evidence || "")), 800),
      sourceRole,
      authority: clampInt(row.authority, 0, 1000, sourceRole === "user" ? 100 : 40),
      confidence: clampInt(row.confidence, 0, 100, 0),
      turnNo: Math.max(0, Math.trunc(Number(row.turnNo) || 0)),
    };
    if (!fact.id || !fact.subjectKey || !fact.subjectName || !fact.value) continue;
    if (!CANONICAL_FACT_KEYS.includes(fact.factKey)) continue;
    const key = `${normalizedKey(fact.subjectKey)}\u0000${fact.factKey}`;
    const list = groups.get(key) || [];
    list.push(fact);
    groups.set(key, list);
  }

  const resolved: ResolvedCanonicalFact[] = [];
  for (const facts of groups.values()) {
    // User-authored facts are authoritative. Assistant-only identity claims are
    // promoted only after the same value is independently repeated in two turns,
    // preventing a single mistaken speaker switch from becoming permanent canon.
    const fact = resolveCanonicalFactCandidate(facts);
    if (fact) resolved.push(fact);
  }
  return resolved.sort(
    (a, b) =>
      a.subjectName.localeCompare(b.subjectName, "ko-KR") ||
      a.factKey.localeCompare(b.factKey)
  );
}

const FACT_LABELS: Record<CanonicalFactKey, string> = {
  age: "나이",
  gender: "성별",
  height: "키",
  weight: "체중",
  body_build: "체형",
  appearance: "외모",
  occupation: "직업",
  background: "배경",
  identity: "정체",
  speech_style: "말투",
  residence: "거주지",
};

export function formatCanonicalCharacterFactsBlock(params: {
  persona: AuthoritativePersonaFacts;
  facts: ResolvedCanonicalFact[];
  focusNames?: string[];
}) {
  const persona = params.persona;
  const focus = new Set(
    (params.focusNames || [])
      .map(normalizedKey)
      .filter(Boolean)
  );
  if (persona.name) focus.add(normalizedKey(persona.name));

  const selected = params.facts.filter((fact) => {
    if (canonicalFactConflictsWithPersona(fact, persona)) return false;
    // Repetition does not make an assistant-invented body description true.
    // Only user-authored NPC physical facts may enter the hard canon prompt;
    // the persona's authoritative settings are rendered separately below.
    if (
      fact.subjectKey !== "persona" &&
      fact.sourceRole !== "user" &&
      ["height", "weight", "body_build", "appearance"].includes(fact.factKey)
    ) {
      return false;
    }
    if (!focus.size) return true;
    const name = normalizedKey(fact.subjectName);
    const key = normalizedKey(fact.subjectKey);
    return fact.subjectKey === "persona" || focus.has(name) || focus.has(key);
  });

  const rows = [
    "# [인물별 정본 사실 — AI 지문·사건 요약보다 우선]",
    "- 페르소나/프리셋 설정과 사용자가 직접 확정·정정한 사실이 최우선이다. AI가 이전 답변에서 임의로 붙인 형용사·추측·비유는 정본을 변경하지 못한다.",
    "- 아래 수치·직업·외형·정체·거주지를 뜻이 바뀌는 동의어로 바꾸지 말고, 모순되는 묘사를 새로 만들지 않는다.",
    "- 특히 AI가 반복해서 쓴 키·체중·체형·외모는 사용자 확정 없이 정본이 되지 않는다.",
    "- 관계·나이·직업·신체·거주지가 실제로 변한 경우에만 최신 사용자의 명시적 서술/OOC로 갱신한다.",
  ];
  if (persona.name) {
    const personaParts: string[] = [];
    if (persona.age > 0) personaParts.push(`나이 ${persona.age}세`);
    if (persona.gender) personaParts.push(`성별 ${persona.gender}`);
    if (persona.heightCm !== null) personaParts.push(`키 ${persona.heightCm}cm`);
    if (persona.weightKg !== null) personaParts.push(`체중 ${persona.weightKg}kg`);
    if (personaParts.length) rows.push(`- ${persona.name}: ${personaParts.join(", ")}`);
    if (persona.info) {
      rows.push(
        `- ${persona.name}의 상세 신체·직업·배경 설정은 위 페르소나 블록의 원문이 정본이며, AI가 임의로 보충하거나 반대로 바꾸지 않는다.`
      );
    }
    if (persona.weightKg !== null && persona.weightKg >= 100) {
      rows.push(
        `- ${persona.name}의 체중은 ${persona.weightKg}kg이므로 '왜소한 몸집', '마른 체구', '가녀린 체격'처럼 체중과 정반대인 묘사를 금지한다.`
      );
    }
  }
  for (const fact of selected.slice(0, 120)) {
    rows.push(
      `- ${fact.subjectName} · ${FACT_LABELS[fact.factKey]}: ${fact.value} ` +
        `(근거: ${fact.sourceRole === "user" ? "사용자 확정" : "검증된 이전 서술"}, ${fact.turnNo}턴)`
    );
  }
  return rows.length > 5 ? rows.join("\n") : "";
}

function taggedUserText(sourceText: string) {
  return String(sourceText || "")
    .split(/(?=\[(?:사용자|어시스턴트)\])/u)
    .filter((part) => /^\[사용자\]/u.test(part.trimStart()))
    .join("\n");
}

function subjectContextContains(text: string, subjectName: string, pattern: RegExp) {
  const source = String(text || "");
  const name = cleanText(subjectName, 80);
  if (!name) return false;
  const indexes: number[] = [];
  let from = 0;
  while (from < source.length) {
    const index = source.indexOf(name, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + name.length;
  }
  return indexes.some((index) => pattern.test(source.slice(Math.max(0, index - 100), index + 180)));
}

export function analyzeCanonicalFactDrift(params: {
  sourceText: string;
  summary: string;
  persona: AuthoritativePersonaFacts;
  facts: ResolvedCanonicalFact[];
}) {
  const summary = cleanText(params.summary, 10000);
  const userText = taggedUserText(params.sourceText);
  const conflicts: string[] = [];
  const persona = params.persona;

  if (persona.name && persona.weightKg !== null) {
    const userAllowsSmall = subjectContextContains(userText, persona.name, SMALL_BUILD_RE);
    const userAllowsLarge = subjectContextContains(userText, persona.name, LARGE_BUILD_RE);
    if (
      persona.weightKg >= 100 &&
      subjectContextContains(summary, persona.name, SMALL_BUILD_RE) &&
      !userAllowsSmall
    ) {
      conflicts.push(`${persona.name}:체중과 반대인 왜소/마른 체형`);
    }
    if (
      persona.weightKg <= 45 &&
      subjectContextContains(summary, persona.name, LARGE_BUILD_RE) &&
      !userAllowsLarge
    ) {
      conflicts.push(`${persona.name}:체중과 반대인 거구/육중 체형`);
    }

    const weightPattern = /(\d{2,3}(?:\.\d+)?)\s*(?:kg|㎏|킬로그램|킬로)/giu;
    const personaAt = summary.indexOf(persona.name);
    const context = personaAt >= 0
      ? summary.slice(Math.max(0, personaAt - 80), personaAt + 240)
      : "";
    for (const match of context.matchAll(weightPattern)) {
      const proposed = Number(match[1]);
      if (Number.isFinite(proposed) && Math.abs(proposed - persona.weightKg) > 0.01) {
        const userHasUpdate = new RegExp(
          `${persona.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]{0,120}${match[1]}\\s*(?:kg|㎏|킬로그램|킬로)`,
          "iu"
        ).test(userText);
        if (!userHasUpdate) conflicts.push(`${persona.name}:체중 수치 ${match[1]}kg`);
      }
    }
  }

  // Static body adjectives that exist only in assistant prose belong to the
  // structured fact extractor, not to event memory summaries.
  const summaryDescriptors = [...summary.matchAll(PHYSICAL_DESCRIPTOR_RE)].map((m) => m[0]);
  for (const descriptor of summaryDescriptors) {
    if (userText.includes(descriptor)) continue;
    const known = params.facts.some((fact) =>
      (fact.factKey === "body_build" || fact.factKey === "appearance") &&
      fact.value.includes(descriptor)
    );
    if (!known) conflicts.push(`AI 지문에서만 나온 신체 묘사:${descriptor}`);
  }

  const unique = [...new Set(conflicts)];
  return {
    ok: unique.length === 0,
    reason: unique.length ? unique.join(", ") : "",
    conflicts: unique,
  };
}
