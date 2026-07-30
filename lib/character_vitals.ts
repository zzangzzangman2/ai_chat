import { randomUUID } from "crypto";

import { decryptIfPossible } from "@/lib/crypto";
import { db } from "@/lib/db";
import type { IdentityCanon, IdentityMessageLike } from "@/lib/identity_memory";

export type CharacterGraphNode = {
  id: string;
  key: string;
  name: string;
  rosterId: string;
  age: number;
  ageSource: string;
  role: string;
  relationshipNote: string;
  profile: string;
  isPersona: boolean;
  isUnknown: boolean;
  updatedAt: number;
};

type TimelineMessage = IdentityMessageLike & {
  createdAt?: unknown;
};

type RosterSeed = {
  id: string;
  name: string;
  aliases: string[];
  role: string;
  profile: string;
  relationshipNote: string;
  createdAt: number;
};

type VitalState = {
  key: string;
  name: string;
  rosterId: string;
  nodeRole: string;
  aliases: string[];
  age: number;
  ageSource: string;
  sourceOrder: number;
  activeFrom: number;
};

function cleanText(value: unknown, max = 400) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function escapeRegex(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedUserText(value: unknown) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/"[^"\n]{1,500}"/g, " ")
    .replace(/“[^”\n]{1,500}”/g, " ")
    .replace(/‘[^’\n]{1,500}’/g, " ")
    .replace(/'[^'\n]{1,500}'/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function personKey(name: string, personaName: string) {
  const value = cleanText(name, 80);
  if (value && value.toLowerCase() === cleanText(personaName, 80).toLowerCase()) {
    return "persona";
  }
  return `name:${value.toLowerCase()}`;
}

function validAge(value: unknown) {
  const age = Math.trunc(Number(value));
  return Number.isFinite(age) && age > 0 && age <= 150 ? age : 0;
}

function koreanAgeToken(tokenRaw: string) {
  const token = String(tokenRaw || "").trim();
  if (!token) return 0;
  const direct: Record<string, number> = {
    한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4,
    다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9,
    열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50,
    예순: 60, 일흔: 70, 여든: 80, 아흔: 90,
  };
  if (direct[token]) return direct[token];
  const tens = [
    ["아흔", 90], ["여든", 80], ["일흔", 70], ["예순", 60], ["마흔", 40],
    ["서른", 30], ["스물", 20], ["스무", 20], ["열", 10],
  ] as const;
  const ones: Record<string, number> = {
    한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4,
    다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9,
  };
  for (const [prefix, base] of tens) {
    if (!token.startsWith(prefix)) continue;
    const tail = token.slice(prefix.length);
    if (!tail) return base;
    if (ones[tail]) return base + ones[tail];
  }
  const sinoDigits: Record<string, number> = {
    일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9,
  };
  if (token === "백") return 100;
  const hundredIndex = token.indexOf("백");
  const hundred = hundredIndex >= 0
    ? (sinoDigits[token.slice(0, hundredIndex)] || 1) * 100
    : 0;
  const afterHundred = hundredIndex >= 0 ? token.slice(hundredIndex + 1) : token;
  const tenIndex = afterHundred.indexOf("십");
  const ten = tenIndex >= 0
    ? (sinoDigits[afterHundred.slice(0, tenIndex)] || 1) * 10
    : 0;
  const tail = tenIndex >= 0 ? afterHundred.slice(tenIndex + 1) : afterHundred;
  return validAge(hundred + ten + (sinoDigits[tail] || 0));
}

function normalizeKoreanAgeWords(textRaw: string) {
  return String(textRaw || "").replace(
    /([가-힣]{1,6})\s*(살|세)(?=\s|[,.!?]|$|이|가|은|는|로|야)/gu,
    (full, token, unit) => {
      const age = koreanAgeToken(String(token || ""));
      return age ? `${age}${unit}` : full;
    }
  );
}

function splitAliases(value: unknown) {
  return String(value || "")
    .split(/[\n,;\/|]+/g)
    .map((item) => cleanText(item, 80))
    .filter(Boolean);
}

function extractProfileAge(textRaw: string) {
  const text = normalizeKoreanAgeWords(cleanText(textRaw, 3000));
  if (!text) return 0;
  const explicit = text.match(
    /(?:현재\s*)?나이\s*(?:은|는|이|가|:)?\s*(\d{1,3})\s*(?:살|세)?/u
  );
  if (explicit?.[1]) return validAge(explicit[1]);
  const mentioned = [
    ...new Set(
      Array.from(text.matchAll(/(\d{1,3})\s*(?:살|세)/gu), (match) =>
        validAge(match[1])
      ).filter(Boolean)
    ),
  ];
  return mentioned.length === 1 ? mentioned[0] : 0;
}

function extractNamedAge(text: string, names: string[]) {
  text = normalizeKoreanAgeWords(text);
  for (const rawName of names) {
    const name = cleanText(rawName, 80);
    if (!name) continue;
    const escaped = escapeRegex(name);
    const patterns = [
      new RegExp(`${escaped}\\s*[（(]\\s*(\\d{1,3})\\s*(?:살|세)?\\s*[）)]`, "u"),
      new RegExp(
        `${escaped}(?:의\\s*)?(?:현재\\s*)?나이\\s*(?:은|는|이|가|:)?\\s*(\\d{1,3})\\s*(?:살|세)`,
        "u"
      ),
      new RegExp(
        `${escaped}(?:이는|이가|은|는|이|가)?\\s*(?:현재|이제)?\\s*(\\d{1,3})\\s*(?:살|세)(?:이야|야|이다|입니다|이|가|은|는|로|됐|되었)?(?=\\s|[,.!?]|$)`,
        "u"
      ),
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const age = validAge(match?.[1]);
      if (age) return age;
    }
  }
  return 0;
}

function extractPersonaAge(text: string) {
  text = normalizeKoreanAgeWords(text);
  const patterns = [
    /(?:나는|난|저는|전)\s*(?:현재|이제)?\s*(\d{1,3})\s*(?:살|세)/u,
    /(?:내|제)\s*나이\s*(?:은|는|이|가|:)?\s*(\d{1,3})\s*(?:살|세)?/u,
  ];
  for (const pattern of patterns) {
    const age = validAge(text.match(pattern)?.[1]);
    if (age) return age;
  }
  return 0;
}

function timelineAdvance(text: string, currentOffset: number) {
  const amount = (value: unknown) =>
    Math.max(0, Math.min(100, Math.trunc(Number(value || 0))));
  let absoluteText = text;
  let additive = 0;
  absoluteText = absoluteText.replace(
    /(?:그로부터|그날로부터|그때로부터|다시|또)\s*(\d{1,3})\s*년\s*(?:(?:이\s*)?(?:지났|흘렀|경과)|후|뒤)/gu,
    (_full, years) => {
      additive += amount(years);
      return " ";
    }
  );
  const elapsedTargets: number[] = [];
  absoluteText = absoluteText.replace(
    /(\d{1,3})\s*년\s*(?:이\s*)?(?:지났|흘렀|경과)/gu,
    (_full, years) => {
      elapsedTargets.push(amount(years));
      return " ";
    }
  );
  const absoluteTargets = Array.from(
    absoluteText.matchAll(/(\d{1,3})\s*년\s*(?:후|뒤)/gu),
    (match) => amount(match[1])
  ).filter(Boolean).concat(elapsedTargets.filter(Boolean));
  const absoluteTarget = absoluteTargets.length
    ? Math.max(currentOffset, ...absoluteTargets)
    : currentOffset;
  const absoluteDelta = Math.max(0, absoluteTarget - currentOffset);
  const delta = Math.min(100, absoluteDelta + additive);
  return {
    delta,
    nextOffset: Math.min(150, absoluteTarget + additive),
  };
}

function relationAge(
  text: string,
  subjectName: string,
  relation: string
) {
  text = normalizeKoreanAgeWords(text);
  const subject = escapeRegex(subjectName);
  if (!subject) return 0;
  const relationPattern =
    relation === "아버지"
      ? "(?:아빠|아버지)"
      : relation === "어머니"
        ? "(?:엄마|어머니)"
        : escapeRegex(relation);
  const match = text.match(
    new RegExp(
      `${subject}(?:이|의)\\s*${relationPattern}(?:은|는|이|가)?[^.!?\\n]{0,18}?(\\d{1,3})\\s*(?:살|세)`,
      "u"
    )
  );
  return validAge(match?.[1]);
}

function deriveVitalStates(params: {
  messages: TimelineMessage[];
  canon: IdentityCanon;
  personaName: string;
  personaAge: number;
  chatCreatedAt: number;
  roster: RosterSeed[];
}) {
  const personaName = cleanText(params.personaName, 80);
  const states = new Map<string, VitalState>();
  const put = (next: VitalState) => {
    if (!next.key) return;
    const previous = states.get(next.key);
    if (!previous) {
      states.set(next.key, next);
      return;
    }
    states.set(next.key, {
      ...previous,
      name: next.name || previous.name,
      rosterId: next.rosterId || previous.rosterId,
      nodeRole: next.nodeRole || previous.nodeRole,
      aliases: [...new Set([...previous.aliases, ...next.aliases])],
      age: next.age || previous.age,
      ageSource: next.age ? next.ageSource : previous.ageSource,
      sourceOrder: Math.max(previous.sourceOrder, next.sourceOrder),
      activeFrom: previous.rosterId
        ? previous.activeFrom
        : next.rosterId
          ? next.activeFrom
          : Math.min(previous.activeFrom, next.activeFrom),
    });
  };

  if (personaName) {
    put({
      key: "persona",
      name: personaName,
      rosterId: "",
      nodeRole: "페르소나",
      aliases: [],
      age: validAge(params.personaAge),
      ageSource: validAge(params.personaAge) ? "페르소나 설정" : "",
      sourceOrder: -1,
      activeFrom: Math.max(0, Number(params.chatCreatedAt || 0)),
    });
  }

  for (const row of params.roster) {
    const name = cleanText(row.name, 80);
    if (!name || name.toLowerCase() === personaName.toLowerCase()) continue;
    const age = extractProfileAge(`${row.role}\n${row.profile}`);
    put({
      key: personKey(name, personaName),
      name,
      rosterId: cleanText(row.id, 120),
      nodeRole: cleanText(row.role, 500),
      aliases: row.aliases,
      age,
      ageSource: age ? "인물 프로필" : "",
      sourceOrder: -1,
      activeFrom: Math.max(0, Number(row.createdAt || 0)),
    });
  }

  for (const relation of params.canon.roleAnchors) {
    const subjectName = cleanText(relation.subjectName, 80);
    const subjectKey = personKey(subjectName, personaName);
    put({
      key: subjectKey,
      name: subjectName,
      rosterId: "",
      nodeRole: subjectKey === "persona" ? "페르소나" : "관계의 기준 인물",
      aliases: [],
      age: 0,
      ageSource: "",
      sourceOrder: relation.sourceOrder,
      activeFrom: params.chatCreatedAt,
    });
    const relatedName = cleanText(relation.relatedName, 80);
    const relatedKey = relatedName
      ? personKey(relatedName, personaName)
      : `role:${subjectKey}:${relation.relation}:${relation.slotKey || "default"}`.toLowerCase();
    put({
      key: relatedKey,
      name: relatedName,
      rosterId: "",
      nodeRole: `${subjectName}의 ${relation.relation}`,
      aliases: [],
      age: 0,
      ageSource: "",
      sourceOrder: relation.sourceOrder,
      activeFrom: params.chatCreatedAt,
    });
  }

  const messages = (params.messages || [])
    .map((message, sourceOrder) => ({
      role: String(message?.role || "").toLowerCase(),
      text: normalizedUserText(message?.content),
      createdAt: Math.max(0, Number(message?.createdAt || 0)),
      sourceOrder,
    }))
    .filter((message) => message.role === "user" && message.text);

  let timelineOffset = 0;
  for (const message of messages) {
    const advance = timelineAdvance(message.text, timelineOffset);
    timelineOffset = advance.nextOffset;
    const years = advance.delta;
    if (years) {
      for (const state of states.values()) {
        if (!state.age) continue;
        if (message.createdAt && state.activeFrom && message.createdAt < state.activeFrom) continue;
        state.age = Math.min(150, state.age + years);
        state.ageSource = `${years}년 시간 경과`;
        state.sourceOrder = message.sourceOrder;
      }
    }

    const persona = states.get("persona");
    const explicitPersonaAge = persona ? extractPersonaAge(message.text) : 0;
    if (persona && explicitPersonaAge) {
      persona.age = explicitPersonaAge;
      persona.ageSource = "사용자 명시";
      persona.sourceOrder = message.sourceOrder;
      persona.activeFrom = message.createdAt || persona.activeFrom;
    }

    for (const state of states.values()) {
      if (state.key === "persona" || !state.name) continue;
      const age = extractNamedAge(message.text, [state.name, ...state.aliases]);
      if (!age) continue;
      state.age = age;
      state.ageSource = "사용자 명시";
      state.sourceOrder = message.sourceOrder;
      state.activeFrom = message.createdAt || state.activeFrom;
    }

    for (const relation of params.canon.roleAnchors) {
      const subjectKey = personKey(relation.subjectName, personaName);
      const relatedKey = relation.relatedName
        ? personKey(relation.relatedName, personaName)
        : `role:${subjectKey}:${relation.relation}:${relation.slotKey || "default"}`.toLowerCase();
      const state = states.get(relatedKey);
      const age = state
        ? relationAge(message.text, relation.subjectName, relation.relation)
        : 0;
      if (!state || !age) continue;
      state.age = age;
      state.ageSource = "사용자 관계 설정";
      state.sourceOrder = message.sourceOrder;
      state.activeFrom = message.createdAt || state.activeFrom;
    }
  }

  return [...states.values()];
}

export function syncCharacterVitals(params: {
  chatId: string;
  messages: TimelineMessage[];
  canon: IdentityCanon;
  personaName: string;
  personaAge?: number;
}) {
  const chatId = cleanText(params.chatId, 120);
  if (!chatId) return 0;
  const chat = db
    .prepare(`SELECT createdAt FROM chats WHERE id=?`)
    .get(chatId) as { createdAt?: number } | undefined;
  const settings = db
    .prepare(`SELECT personaAge FROM chat_settings WHERE chatId=?`)
    .get(chatId) as { personaAge?: number } | undefined;
  const rosterRows = db
    .prepare(
      `SELECT id, name, aliases, role, profile, relationshipNote, createdAt, updatedAt
       FROM chat_character_roster
       WHERE chatId=? AND enabled != 0`
    )
    .all(chatId) as Array<Record<string, unknown>>;
  const roster: RosterSeed[] = rosterRows.map((row) => ({
    id: cleanText(row.id, 120),
    name: cleanText(row.name, 80),
    aliases: splitAliases(decryptIfPossible(String(row.aliases || ""))),
    role: decryptIfPossible(String(row.role || "")),
    profile: decryptIfPossible(String(row.profile || "")),
    relationshipNote: decryptIfPossible(String(row.relationshipNote || "")),
    createdAt: Math.max(0, Number(row.updatedAt || row.createdAt || 0)),
  }));
  const states = deriveVitalStates({
    messages: params.messages,
    canon: params.canon,
    personaName: params.personaName,
    personaAge: validAge(params.personaAge) || validAge(settings?.personaAge),
    chatCreatedAt: Math.max(0, Number(chat?.createdAt || 0)),
    roster,
  });
  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO chat_character_vitals
       (id, chatId, personKey, personName, rosterId, nodeRole, age, ageSource,
        sourceOrder, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chatId, personKey) DO UPDATE SET
       personName=excluded.personName,
       rosterId=excluded.rosterId,
       nodeRole=excluded.nodeRole,
       age=excluded.age,
       ageSource=excluded.ageSource,
       sourceOrder=excluded.sourceOrder,
       updatedAt=excluded.updatedAt`
  );
  const write = db.transaction(() => {
    const keys = new Set(states.map((state) => state.key));
    for (const state of states) {
      upsert.run(
        randomUUID(),
        chatId,
        state.key,
        state.name,
        state.rosterId,
        state.nodeRole,
        state.age,
        state.ageSource,
        state.sourceOrder,
        now,
        now
      );
    }
    const existing = db
      .prepare(`SELECT id, personKey FROM chat_character_vitals WHERE chatId=?`)
      .all(chatId) as Array<{ id: string; personKey: string }>;
    const remove = db.prepare(`DELETE FROM chat_character_vitals WHERE id=? AND chatId=?`);
    for (const row of existing) {
      if (!keys.has(String(row.personKey || ""))) remove.run(String(row.id || ""), chatId);
    }
  });
  write();
  return states.length;
}

export function loadCharacterGraphNodes(chatIdRaw: string) {
  const chatId = cleanText(chatIdRaw, 120);
  if (!chatId) return [] as CharacterGraphNode[];
  return (
    db
      .prepare(
        `SELECT v.id, v.personKey, v.personName, v.rosterId, v.nodeRole,
                v.age, v.ageSource, v.updatedAt,
                COALESCE(r.role, '') AS rosterRole,
                COALESCE(r.relationshipNote, '') AS relationshipNote,
                COALESCE(r.profile, '') AS profile
         FROM chat_character_vitals v
         LEFT JOIN chat_character_roster r ON r.chatId=v.chatId AND r.id=v.rosterId
         WHERE v.chatId=?
         ORDER BY CASE WHEN v.personKey='persona' THEN 0 ELSE 1 END,
                  v.personName ASC, v.nodeRole ASC`
      )
      .all(chatId) as Array<Record<string, unknown>>
  ).map((row) => {
    const key = String(row.personKey || "");
    const name = String(row.personName || "");
    return {
      id: String(row.id || ""),
      key,
      name: name || "이름 미상",
      rosterId: String(row.rosterId || ""),
      age: validAge(row.age),
      ageSource: String(row.ageSource || ""),
      role:
        cleanText(decryptIfPossible(String(row.rosterRole || "")), 500) ||
        cleanText(row.nodeRole, 500),
      relationshipNote: cleanText(
        decryptIfPossible(String(row.relationshipNote || "")),
        1000
      ),
      profile: cleanText(decryptIfPossible(String(row.profile || "")), 2000),
      isPersona: key === "persona",
      isUnknown: !name,
      updatedAt: Number(row.updatedAt || 0),
    };
  });
}
