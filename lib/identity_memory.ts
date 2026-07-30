export type IdentityMessageLike = {
  role?: unknown;
  content?: unknown;
};

export type CanonicalNameFact = {
  subject: string;
  subjectKey: string;
  canonicalName: string;
  aliases: string[];
  rejectedNames: string[];
  sourceOrder: number;
};

export type FamilyRelation =
  | "아버지" | "어머니" | "딸" | "아들"
  | "손녀" | "손자" | "자녀";

export type ScopedRoleAnchor = {
  subjectName: string;
  relation: FamilyRelation;
  relatedName?: string;
  slotKey?: string;
  sourceOrder: number;
};

export type IdentityCanon = {
  personaName: string;
  nameFacts: CanonicalNameFact[];
  roleAnchors: ScopedRoleAnchor[];
};

const KOREAN_OR_LATIN_NAME = String.raw`(?:[가-힣]{2,8}|[A-Za-z][A-Za-z0-9_-]{1,19})`;
const NAME_ASSIGNMENT_RE = new RegExp(
  String.raw`((?:(?:우리|저희|내|제)\s*)?(?:(?:첫째|둘째|셋째|막내)\s*)?(?:딸|아들|아이|아기|애기|손녀|손자))\s*(?:의\s*)?이름(?:\s*(?:은|이|:)\s*|\s+)(${KOREAN_OR_LATIN_NAME}(?:이야|야)?)`,
  "gu"
);
const MEMORY_NAME_RE = new RegExp(
  String.raw`기억(?:해|하세요|하자)?\s*[,!:\-]?\s*(${KOREAN_OR_LATIN_NAME})`,
  "u"
);
const PERSONA_NAME_PATTERNS = [
  new RegExp(
    String.raw`(?:^|[\s"'*])(?:나는|난|저는|전)\s*(?:만\s*)?(?:\d{1,3}\s*(?:살|세)(?:인|이고|의)?\s*)?(${KOREAN_OR_LATIN_NAME})\s*(?:이야|이다|입니다|예요|라고\s*(?:해|한다))`,
    "iu"
  ),
  new RegExp(
    String.raw`(?:^|[\s"'*])(?:내|제)\s*이름\s*(?:은|이|:)\s*(${KOREAN_OR_LATIN_NAME})`,
    "iu"
  ),
  new RegExp(
    String.raw`(?:주인공|페르소나)(?:의)?\s*이름\s*(?:은|이|:)\s*(${KOREAN_OR_LATIN_NAME})`,
    "iu"
  ),
] as const;

const PERSONA_NAME_STOPWORDS = new Set([
  "주인공",
  "사용자",
  "플레이어",
  "선생님",
  "아버지",
  "어머니",
  "아빠",
  "엄마",
  "남편",
  "아내",
  "사람",
  "인물",
  "남자",
  "여자",
  "실제",
  "진짜",
]);

function stripQuotedDialogue(text: string) {
  return String(text || "")
    .replace(/"[^"\n]{1,500}"/g, " ")
    .replace(/“[^”\n]{1,500}”/g, " ")
    .replace(/‘[^’\n]{1,500}’/g, " ")
    .replace(/'[^'\n]{1,500}'/g, " ");
}

function stripFencedBlocks(text: string) {
  return String(text || "").replace(/```[\s\S]*?```/g, " ");
}

function normalizedMessageText(value: unknown) {
  return stripQuotedDialogue(stripFencedBlocks(String(value || "")))
    .replace(/\s+/g, " ")
    .trim();
}

function userMessages(messages: IdentityMessageLike[]) {
  return (messages || [])
    .map((message, sourceOrder) => ({
      role: String(message?.role || "").toLowerCase(),
      text: normalizedMessageText(message?.content),
      sourceOrder,
    }))
    .filter((message) => message.role === "user" && message.text);
}

function cleanNameToken(raw: string) {
  return String(raw || "")
    .replace(/^[^가-힣A-Za-z]+|[^가-힣A-Za-z0-9_-]+$/g, "")
    .trim();
}

function cleanAssignedName(raw: string) {
  let value = cleanNameToken(raw);
  if (/^[가-힣]{2,8}이야$/u.test(value)) value = value.slice(0, -2);
  else if (/^[가-힣]{2,8}야$/u.test(value)) value = value.slice(0, -1);
  return value;
}

function validPersonaName(raw: string) {
  const value = cleanNameToken(raw);
  if (!value || PERSONA_NAME_STOPWORDS.has(value)) return "";
  if (!new RegExp(`^${KOREAN_OR_LATIN_NAME}$`, "u").test(value)) return "";
  return value;
}

function normalizeSubject(raw: string) {
  const subject = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  const subjectKey = subject
    .replace(/^(?:우리|저희|내|제)\s*/u, "")
    .replace(/\s+/g, "");
  return { subject, subjectKey: subjectKey || subject };
}

function nameIsAliasOf(candidate: string, canonicalName: string) {
  if (!candidate || !canonicalName || candidate === canonicalName) return false;
  return canonicalName.endsWith(candidate) || candidate.endsWith(canonicalName);
}

export function inferPersonaNameFromMessages(messages: IdentityMessageLike[]) {
  const users = userMessages(messages);
  let earliest = "";
  let explicitOverride = "";

  for (let i = 0; i < users.length; i++) {
    const item = users[i];
    let picked = "";
    for (const pattern of PERSONA_NAME_PATTERNS) {
      const match = pattern.exec(item.text);
      if (!match?.[1]) continue;
      picked = validPersonaName(match[1]);
      if (picked) break;
    }
    if (!picked) continue;

    if (!earliest && i < 30) earliest = picked;
    if (/(?:^|\s)(?:ooc|설정|정정)\s*[:：]?/iu.test(item.text) || /(?:주인공|페르소나)(?:의)?\s*이름/u.test(item.text)) {
      explicitOverride = picked;
    }
  }

  return explicitOverride || earliest;
}

export function extractCanonicalNameFacts(messages: IdentityMessageLike[]) {
  const factsBySubject = new Map<string, CanonicalNameFact>();

  for (const message of userMessages(messages)) {
    NAME_ASSIGNMENT_RE.lastIndex = 0;
    for (const match of message.text.matchAll(NAME_ASSIGNMENT_RE)) {
      const { subject, subjectKey } = normalizeSubject(match[1]);
      const firstName = cleanAssignedName(match[2]);
      if (!subjectKey || !firstName) continue;

      const tail = message.text.slice(Number(match.index || 0) + match[0].length, Number(match.index || 0) + match[0].length + 100);
      const remembered = cleanNameToken(tail.match(MEMORY_NAME_RE)?.[1] || "");
      const canonicalName = remembered || firstName;
      const aliases = new Set<string>();
      const rejectedNames = new Set<string>();
      if (firstName !== canonicalName) {
        if (nameIsAliasOf(firstName, canonicalName)) aliases.add(firstName);
        else rejectedNames.add(firstName);
      }

      const previous = factsBySubject.get(subjectKey);
      if (previous) {
        for (const alias of previous.aliases) aliases.add(alias);
        for (const rejected of previous.rejectedNames) rejectedNames.add(rejected);
        if (previous.canonicalName !== canonicalName) {
          if (nameIsAliasOf(previous.canonicalName, canonicalName)) aliases.add(previous.canonicalName);
          else rejectedNames.add(previous.canonicalName);
        }
      }
      aliases.delete(canonicalName);
      rejectedNames.delete(canonicalName);
      for (const alias of aliases) rejectedNames.delete(alias);

      factsBySubject.set(subjectKey, {
        subject,
        subjectKey,
        canonicalName,
        aliases: [...aliases],
        rejectedNames: [...rejectedNames],
        sourceOrder: message.sourceOrder,
      });
    }
  }

  return [...factsBySubject.values()]
    .sort((a, b) => a.sourceOrder - b.sourceOrder)
    .slice(-120);
}

function uniqueKnownNames(values: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const name = validPersonaName(raw);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.sort((a, b) => b.length - a.length);
}

export function extractScopedRoleAnchors(
  messages: IdentityMessageLike[],
  knownNames: string[],
  personaNameRaw = ""
) {
  const anchors = new Map<string, ScopedRoleAnchor>();
  const names = uniqueKnownNames(knownNames);
  if (!names.length) return [] as ScopedRoleAnchor[];
  const personaName = validPersonaName(personaNameRaw);

  for (const message of userMessages(messages)) {
    if (personaName) {
      const personaRelation = /(?:우리|저희|내|제)\s*(?:(?:어린|사랑하는|유일한)\s*)?((?:첫째|둘째|셋째|막내)?\s*)(아빠|아버지|엄마|어머니|부모|딸|아들|손녀|손자|자녀)/gu;
      for (const match of message.text.matchAll(personaRelation)) {
        const ordinal = String(match[1] || "").replace(/\s+/g, "");
        const term = String(match[2] || "");
        let relatedName = "";
        for (const candidate of names) {
          if (candidate === personaName) continue;
          const candidateEscaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const termEscaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const fromRole = new RegExp(
            `(?:우리|저희|내|제)\\s*(?:(?:어린|사랑하는|유일한)\\s*)?(?:첫째|둘째|셋째|막내)?\\s*${termEscaped}(?:인|은|는|이|가|:)?\\s*${candidateEscaped}(?:은|는|이|가)?(?=\\s|[,.!?]|$)`,
            "u"
          );
          const fromName = new RegExp(
            `${candidateEscaped}(?:은|는|이|가)\\s*(?:우리|저희|내|제)\\s*(?:(?:어린|사랑하는|유일한)\\s*)?(?:첫째|둘째|셋째|막내)?\\s*${termEscaped}`,
            "u"
          );
          if (fromRole.test(message.text) || fromName.test(message.text)) {
            relatedName = candidate;
            break;
          }
        }
        const relations: FamilyRelation[] =
          term === "부모"
            ? ["아버지", "어머니"]
            : term === "아빠" || term === "아버지"
              ? ["아버지"]
              : term === "엄마" || term === "어머니"
                ? ["어머니"]
                : /아이|아기|애기/u.test(term)
                  ? ["자녀"]
                  : [term as FamilyRelation];
        for (const relation of relations) {
          const slotKey = `${ordinal}${relation}` || "default";
          const key = `${personaName}:${relation}:${slotKey}`;
          const previous = anchors.get(key);
          anchors.set(key, {
            subjectName: personaName,
            relation,
            relatedName: relatedName || previous?.relatedName || "",
            slotKey,
            sourceOrder: message.sourceOrder,
          });
        }
      }
    }

    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const direct = new RegExp(
        `${escaped}(?:이|의)\\s*(아빠|아버지|엄마|어머니|부모|딸|아들|손녀|손자|자녀)`,
        "gu"
      );
      const scopedPronoun = new RegExp(
        `${escaped}[^.!?\\n]{0,28}(?:그|그녀|걔)의\\s*((?:(?:아빠|아버지|엄마|어머니|부모|딸|아들|손녀|손자|자녀)[\\s,]*){1,6})`,
        "gu"
      );
      const terms = [
        ...Array.from(message.text.matchAll(direct), (match) => match[1]),
        ...Array.from(message.text.matchAll(scopedPronoun)).flatMap((match) =>
          Array.from(
            String(match[1] || "").matchAll(/아빠|아버지|엄마|어머니|부모|딸|아들|손녀|손자|자녀/gu),
            (termMatch) => termMatch[0]
          )
        ),
      ];
      for (const term of terms) {
        const relations: FamilyRelation[] =
          term === "부모"
            ? ["아버지", "어머니"]
            : term === "아빠" || term === "아버지"
              ? ["아버지"]
              : term === "엄마" || term === "어머니"
                ? ["어머니"]
                : [term as FamilyRelation];
        for (const relation of relations) {
          const key = `${name}:${relation}`;
          const previous = anchors.get(key);
          anchors.set(key, {
            subjectName: name,
            relation,
            relatedName: previous?.relatedName || "",
            slotKey: previous?.slotKey || "default",
            sourceOrder: message.sourceOrder,
          });
        }
      }

      const relationPatterns: Array<{ relation: FamilyRelation; pattern: string }> = [
        { relation: "아버지", pattern: "(?:아빠|아버지)" },
        { relation: "어머니", pattern: "(?:엄마|어머니)" },
        { relation: "딸", pattern: "딸" },
        { relation: "아들", pattern: "아들" },
        { relation: "손녀", pattern: "손녀" },
        { relation: "손자", pattern: "손자" },
        { relation: "자녀", pattern: "자녀" },
      ];
      for (const entry of relationPatterns) {
        const namedByAssignment = message.text.match(
          new RegExp(
            `${escaped}(?:이|의)\\s*${entry.pattern}\\s*(?:의\\s*)?이름(?:\\s*(?:은|이|:)\\s*|\\s+)((?:[가-힣]{2,8}?|[A-Za-z][A-Za-z0-9_-]{1,19}))(?=\\s*(?:이야|야|이다|입니다|이고|이며|인데|라는|라고|다|[,.!?]|$))`,
            "u"
          )
        );
        const namedByInverse = message.text.match(
          new RegExp(
            `(${KOREAN_OR_LATIN_NAME})(?:은|는|이|가)\\s*${escaped}(?:이|의)\\s*${entry.pattern}`,
            "u"
          )
        );
        let relatedName =
          validPersonaName(namedByAssignment?.[1] || "") ||
          validPersonaName(namedByInverse?.[1] || "");

        if (!relatedName) {
          for (const candidate of names) {
            if (candidate === name) continue;
            const candidateEscaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (
              new RegExp(
                `${escaped}(?:이|의)\\s*${entry.pattern}\\s*(?:은|는|이|가|:)\\s*${candidateEscaped}(?=\\s|[,.!?]|$)`,
                "u"
              ).test(message.text)
            ) {
              relatedName = candidate;
              break;
            }
          }
        }
        if (!relatedName) continue;
        anchors.set(`${name}:${entry.relation}`, {
          subjectName: name,
          relation: entry.relation,
          relatedName,
          slotKey: "default",
          sourceOrder: message.sourceOrder,
        });
      }
    }
  }

  return [...anchors.values()]
    .sort((a, b) => a.sourceOrder - b.sourceOrder || a.subjectName.localeCompare(b.subjectName, "ko"))
    .slice(-160);
}

export function deriveIdentityCanon(params: {
  messages: IdentityMessageLike[];
  knownNames?: string[];
  personaName?: string;
}): IdentityCanon {
  const nameFacts = extractCanonicalNameFacts(params.messages);
  const inferredPersonaName = inferPersonaNameFromMessages(params.messages);
  const personaName = validPersonaName(String(params.personaName || "")) || inferredPersonaName;
  const knownNames = uniqueKnownNames([
    ...(params.knownNames || []),
    personaName,
    ...nameFacts.flatMap((fact) => [fact.canonicalName, ...fact.aliases]),
  ]);
  const roleAnchors = extractScopedRoleAnchors(params.messages, knownNames, personaName);
  if (personaName) {
    for (const fact of nameFacts) {
      const key = fact.subjectKey.replace(/\s+/g, "");
      const relation: FamilyRelation | "" =
        key.includes("손녀")
          ? "손녀"
          : key.includes("손자")
            ? "손자"
            : key.includes("딸")
              ? "딸"
              : key.includes("아들")
                ? "아들"
                : /아이|아기|애기/u.test(key)
                  ? "자녀"
                  : "";
      if (!relation) continue;
      const slotKey = key || "default";
      const existing = roleAnchors.find(
        (anchor) =>
          anchor.subjectName === personaName &&
          anchor.relation === relation &&
          (!anchor.relatedName || anchor.relatedName === fact.canonicalName)
      );
      if (existing) {
        existing.relatedName = fact.canonicalName;
        existing.slotKey = slotKey;
        existing.sourceOrder = Math.max(existing.sourceOrder, fact.sourceOrder);
      } else {
        roleAnchors.push({
          subjectName: personaName,
          relation,
          relatedName: fact.canonicalName,
          slotKey,
          sourceOrder: fact.sourceOrder,
        });
      }
    }
  }
  return { personaName, nameFacts, roleAnchors };
}

export function formatIdentityCanonBlock(canon: IdentityCanon) {
  const rows: string[] = [
    "# [인물 정체성·가족관계 정사 — 장기기억보다 우선]",
    "- 인물 이름과 가족관계는 반드시 `(대상 인물, 관계, 상대 인물)` 단위로 구분한다. 같은 '아빠/엄마/딸/아들' 호칭이라도 대상이나 세대가 다르면 별개의 관계다.",
    "- 이름이 없는 'A의 아버지/어머니/딸/아들'도 독립된 역할 인물이다. 이름이 나중에 밝혀지면 같은 역할 인물에 이름만 연결하고 새 인물로 중복 생성하지 않는다.",
    "- 등장인물의 대사 속 주장, 질문, 거짓말, 추측, 사진·편지의 발신자는 그 자체로 혈연이나 정체성 확정 근거가 아니다.",
    "- '우리/저희/내/제'는 기본적으로 소유·복수 표현이다. 사용자가 '이름은 우리'처럼 명시적으로 이름을 정한 경우가 아니면 인명으로 해석하지 않는다.",
    "- 이미 명시된 이름은 이후의 모호한 호칭, 오타, 대사 속 자칭만으로 바꾸지 않는다. 변경은 사용자의 명시적 설정 변경·정정만 인정한다.",
  ];

  if (canon.personaName) {
    rows.push(
      `[주인공 고정] 사용자가 조종하는 인물의 이름은 ${JSON.stringify(canon.personaName)}이다. 같은 이름의 등록 캐릭터 항목이 있더라도 별도 NPC로 등장시키지 않는다.`
    );
  }
  if (canon.nameFacts.length) {
    rows.push("[고정 이름]");
    for (const fact of canon.nameFacts) {
      const aliases = fact.aliases.length ? ` | 짧은 호칭/별칭: ${fact.aliases.join(", ")}` : "";
      const rejected = fact.rejectedNames.length ? ` | 폐기된 이름: ${fact.rejectedNames.join(", ")}` : "";
      rows.push(`- ${fact.subject}: ${fact.canonicalName}${aliases}${rejected}`);
    }
  }
  if (canon.roleAnchors.length) {
    rows.push("[구조화 가족관계]");
    for (const anchor of canon.roleAnchors) {
      if (anchor.relatedName) {
        rows.push(`- ${anchor.subjectName} → ${anchor.relation} → ${anchor.relatedName}`);
      } else {
        rows.push(
          `- ${anchor.subjectName} → ${anchor.relation} → 이름 미상 역할 인물. 다른 이름 있는 인물과 임의 동일시 금지.`
        );
      }
    }
  }
  return rows.join("\n");
}

export function buildIdentityCanonBlock(params: {
  messages: IdentityMessageLike[];
  knownNames?: string[];
  personaName?: string;
}) {
  const canon = deriveIdentityCanon(params);
  return { canon, block: formatIdentityCanonBlock(canon) };
}

function containsName(text: string, name: string) {
  return Boolean(name) && String(text || "").includes(name);
}

export function analyzeIdentityCanonDrift(params: {
  sourceText: string;
  summary: string;
  canon: IdentityCanon;
}) {
  const source = normalizedMessageText(params.sourceText);
  const summary = normalizedMessageText(params.summary);
  const missingCanonicalNames: string[] = [];
  const rejectedNames: string[] = [];

  for (const fact of params.canon.nameFacts) {
    const references = [
      fact.canonicalName,
      ...fact.aliases,
      fact.subject,
      fact.subjectKey,
    ].filter(Boolean);
    const relevant = references.some((value) => containsName(source, value));
    if (!relevant) continue;

    const sourceHasExplicitNameAssignment =
      [fact.subject, fact.subjectKey].some((subject) => {
        const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`${escaped}\\s*(?:의\\s*)?이름`, "u").test(source);
      }) && containsName(source, fact.canonicalName);
    const summaryReferencesEntity = references.some((value) => containsName(summary, value));
    if (sourceHasExplicitNameAssignment && !containsName(summary, fact.canonicalName)) {
      missingCanonicalNames.push(fact.canonicalName);
    }
    if (summaryReferencesEntity && !containsName(summary, fact.canonicalName)) {
      missingCanonicalNames.push(fact.canonicalName);
    }
    for (const rejected of fact.rejectedNames) {
      if (containsName(summary, rejected)) rejectedNames.push(rejected);
    }

    if (
      !containsName(summary, fact.canonicalName) &&
      /(?:딸|아들|아이|아기|애기)\s+우리(?:야)?(?:가|는|를|에게|의)?(?=\s|[,.!?]|$)/u.test(summary)
    ) {
      missingCanonicalNames.push(fact.canonicalName);
      rejectedNames.push("우리(인명 오인)");
    }
  }

  const missing = [...new Set(missingCanonicalNames)];
  const rejected = [...new Set(rejectedNames)];
  return missing.length || rejected.length
    ? {
        ok: false,
        reason: "identity_canon_drift",
        missingCanonicalNames: missing,
        rejectedNames: rejected,
      }
    : {
        ok: true,
        reason: "ok",
        missingCanonicalNames: [] as string[],
        rejectedNames: [] as string[],
      };
}
