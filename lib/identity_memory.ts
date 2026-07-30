export type IdentityMessageLike = {
  role?: unknown;
  content?: unknown;
};

export type IdentityCharacterSource = {
  name?: unknown;
  role?: unknown;
  profile?: unknown;
  relationshipNote?: unknown;
  emotionNote?: unknown;
  status?: unknown;
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
  | "손녀" | "손자" | "자녀" | "부모"
  | "할아버지" | "할머니" | "조부모" | "손자녀"
  | "언니" | "누나" | "오빠" | "형"
  | "동생" | "여동생" | "남동생" | "자매" | "형제" | "형제자매"
  | "배우자" | "연인" | "친구" | "절친" | "소꿉친구"
  | "같은 반 친구" | "동급생" | "같은 학교" | "선배" | "후배"
  | "동료" | "상사" | "부하 직원" | "스승" | "제자"
  | "보호자" | "담당자" | "이웃" | "지인"
  | "원수" | "라이벌" | "가해자" | "피해자";

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
      const personaRelation = /(?:우리|저희|내|제)\s*(?:(?:어린|사랑하는|유일한)\s*)?((?:첫째|둘째|셋째|막내)?\s*)(아빠|아버지|엄마|어머니|부모|할아버지|할머니|조부모|딸|아들|손녀|손자|손자녀|자녀|여동생|남동생|동생|언니|누나|오빠|형|자매|형제자매|형제)/gu;
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
        if (!relatedName) continue;
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
      const relationPatterns: Array<{ relation: FamilyRelation; pattern: string }> = [
        { relation: "아버지", pattern: "(?:아빠|아버지)" },
        { relation: "어머니", pattern: "(?:엄마|어머니)" },
        { relation: "부모", pattern: "부모" },
        { relation: "할아버지", pattern: "할아버지" },
        { relation: "할머니", pattern: "할머니" },
        { relation: "조부모", pattern: "조부모" },
        { relation: "딸", pattern: "딸" },
        { relation: "아들", pattern: "아들" },
        { relation: "손녀", pattern: "손녀" },
        { relation: "손자", pattern: "손자" },
        { relation: "손자녀", pattern: "손자녀" },
        { relation: "자녀", pattern: "자녀" },
        { relation: "여동생", pattern: "여동생" },
        { relation: "남동생", pattern: "남동생" },
        { relation: "동생", pattern: "(?<!여|남)동생" },
        { relation: "언니", pattern: "언니" },
        { relation: "누나", pattern: "누나" },
        { relation: "오빠", pattern: "오빠" },
        { relation: "형", pattern: "형(?!제)" },
        { relation: "자매", pattern: "자매" },
        { relation: "형제자매", pattern: "형제자매" },
        { relation: "형제", pattern: "형제(?!자매)" },
        { relation: "배우자", pattern: "(?:배우자|남편|아내)" },
        { relation: "연인", pattern: "(?:연인|애인|남자친구|여자친구|약혼자)" },
        { relation: "같은 반 친구", pattern: "(?:같은\\s*반\\s*친구|반\\s*친구|학급\\s*친구)" },
        { relation: "동급생", pattern: "(?:동급생|같은\\s*학년)" },
        { relation: "같은 학교", pattern: "(?:같은\\s*학교|동문)" },
        { relation: "소꿉친구", pattern: "소꿉친구" },
        { relation: "절친", pattern: "(?:절친|가장\\s*친한\\s*친구)" },
        { relation: "친구", pattern: "친구" },
        { relation: "선배", pattern: "선배" },
        { relation: "후배", pattern: "후배" },
        { relation: "동료", pattern: "(?:직장\\s*)?동료" },
        { relation: "상사", pattern: "(?:상사|관리자)" },
        { relation: "부하 직원", pattern: "(?:부하\\s*직원|부하|직원)" },
        { relation: "스승", pattern: "(?:스승|담임|선생님|교사|교수|멘토)" },
        { relation: "제자", pattern: "(?:제자|담당\\s*학생)" },
        { relation: "보호자", pattern: "(?:보호자|후견인)" },
        { relation: "담당자", pattern: "(?:담당자|담당관)" },
        { relation: "이웃", pattern: "이웃" },
        { relation: "지인", pattern: "지인" },
        { relation: "원수", pattern: "(?:원수|적대\\s*관계)" },
        { relation: "라이벌", pattern: "(?:라이벌|경쟁자|숙적)" },
        { relation: "가해자", pattern: "가해자" },
        { relation: "피해자", pattern: "피해자" },
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
            `(${KOREAN_OR_LATIN_NAME})(?:은|는|이|가)\\s*${escaped}(?:이|의)\\s*(?:(?:\\d{1,3}\\s*(?:세|살)|어린|친|막내|첫째|둘째|셋째)\\s*){0,4}${entry.pattern}`,
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

function characterProfileAnchors(sources: IdentityCharacterSource[] = []) {
  const anchors: ScopedRoleAnchor[] = [];
  for (const source of sources) {
    const childName = validPersonaName(String(source?.name || ""));
    if (!childName) continue;
    const text = [
      source?.role,
      source?.profile,
      source?.relationshipNote,
    ]
      .map((value) => normalizedMessageText(value).replace(/^\(자동 탐지\)\s*/u, ""))
      .filter(Boolean)
      .join(" ");
    if (!text) continue;
    const bornFrom = text.match(
      new RegExp(
        `(${KOREAN_OR_LATIN_NAME})(?:은|는|이|가|에게서)\\s*(?:직접\\s*)?(?:낳은|출산한|출산해\\s*낳은)[^.!?\\n]{0,40}(딸|아들)`,
        "u"
      )
    );
    const parentName = validPersonaName(String(bornFrom?.[1] || ""));
    const relation = String(bornFrom?.[2] || "") as FamilyRelation;
    if (!parentName || parentName === childName || !["딸", "아들"].includes(relation)) {
      continue;
    }
    anchors.push({
      subjectName: parentName,
      relation,
      relatedName: childName,
      slotKey: `${relation}:${childName}`,
      sourceOrder: 0,
    });
  }
  return anchors;
}

type SchoolContext = {
  name: string;
  school: string;
  grade: number;
  classNo: number;
};

function schoolContextForSource(source: IdentityCharacterSource): SchoolContext | null {
  const name = validPersonaName(String(source?.name || ""));
  if (!name) return null;
  const text = [
    source?.role,
    source?.profile,
    source?.relationshipNote,
  ]
    .map((value) => normalizedMessageText(value).replace(/^\(자동 탐지\)\s*/u, ""))
    .filter(Boolean)
    .join(" ");
  if (!text) return null;
  const school = String(
    text.match(/([가-힣A-Za-z0-9·._-]{2,30}(?:초등학교|중학교|고등학교|예술고등학교|예고|고교|대학교|대학))/u)?.[1] || ""
  )
    .replace(/\s+/g, "")
    .trim();
  if (!school) return null;
  const grade = Math.max(0, Number(text.match(/(\d{1,2})\s*학년/u)?.[1] || 0));
  const classNo = Math.max(0, Number(text.match(/(\d{1,2})\s*반/u)?.[1] || 0));
  return { name, school, grade, classNo };
}

function characterPeerAnchors(sources: IdentityCharacterSource[] = []) {
  const contexts = sources
    .map(schoolContextForSource)
    .filter(Boolean) as SchoolContext[];
  const anchors: ScopedRoleAnchor[] = [];
  for (let left = 0; left < contexts.length; left += 1) {
    for (let right = left + 1; right < contexts.length; right += 1) {
      const a = contexts[left];
      const b = contexts[right];
      if (a.name === b.name || a.school !== b.school) continue;
      const relation: FamilyRelation =
        a.grade > 0 && b.grade > 0 && a.grade === b.grade &&
        a.classNo > 0 && b.classNo > 0 && a.classNo === b.classNo
          ? "같은 반 친구"
          : a.grade > 0 && b.grade > 0 && a.grade === b.grade
            ? "동급생"
            : "같은 학교";
      const [subjectName, relatedName] =
        a.name.localeCompare(b.name, "ko") <= 0
          ? [a.name, b.name]
          : [b.name, a.name];
      anchors.push({
        subjectName,
        relation,
        relatedName,
        slotKey: `${a.school}:${a.grade || 0}:${a.classNo || 0}:${relatedName}`,
        sourceOrder: 0,
      });
    }
  }
  return anchors;
}

function characterIdentityMessages(sources: IdentityCharacterSource[] = []) {
  const messages: IdentityMessageLike[] = [];
  for (const source of sources) {
    const name = validPersonaName(String(source?.name || ""));
    if (!name) continue;
    for (const value of [
      source?.role,
      source?.profile,
      source?.relationshipNote,
    ]) {
      const fact = normalizedMessageText(value).replace(/^\(자동 탐지\)\s*/u, "").trim();
      if (!fact) continue;
      messages.push({ role: "user", content: `${name}은 ${fact}` });
    }
  }
  return messages;
}

export function deriveIdentityCanon(params: {
  messages: IdentityMessageLike[];
  knownNames?: string[];
  personaName?: string;
  characterSources?: IdentityCharacterSource[];
}): IdentityCanon {
  const nameFacts = extractCanonicalNameFacts(params.messages);
  const inferredPersonaName = inferPersonaNameFromMessages(params.messages);
  const personaName = validPersonaName(String(params.personaName || "")) || inferredPersonaName;
  const knownNames = uniqueKnownNames([
    ...(params.knownNames || []),
    personaName,
    ...nameFacts.flatMap((fact) => [fact.canonicalName, ...fact.aliases]),
  ]);
  const supplementalAnchors = extractScopedRoleAnchors(
    characterIdentityMessages(params.characterSources),
    knownNames,
    personaName
  );
  const profileAnchors = characterProfileAnchors(params.characterSources);
  const peerAnchors = characterPeerAnchors(params.characterSources);
  const explicitAnchors = extractScopedRoleAnchors(params.messages, knownNames, personaName);
  const mergedAnchors = new Map<string, ScopedRoleAnchor>();
  for (const anchor of [...supplementalAnchors, ...profileAnchors, ...peerAnchors, ...explicitAnchors]) {
    if (!validPersonaName(String(anchor.relatedName || ""))) continue;
    const key = [
      anchor.subjectName,
      anchor.relation,
      String(anchor.relatedName || ""),
    ].join("\u0000");
    mergedAnchors.set(key, anchor);
  }
  const roleAnchors = [...mergedAnchors.values()]
    .sort(
      (a, b) =>
        a.sourceOrder - b.sourceOrder ||
        a.subjectName.localeCompare(b.subjectName, "ko")
    )
    .slice(-160);
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
    "# [인물 정체성·구조적 관계 정사 — 장기기억보다 우선]",
    "- 인물 관계는 반드시 `(대상 인물, 관계 유형, 상대 인물)` 단위로 구분한다. 가족·친구·학교·직장 관계와 감정 상태를 섞지 않는다.",
    "- 상대 이름이 확인되지 않은 관계는 관계도 노드로 만들지 않는다. 이름이 확인된 뒤 명시적 근거와 함께 연결한다.",
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
    rows.push("[구조화 인물관계]");
    for (const anchor of canon.roleAnchors) {
      if (!anchor.relatedName) continue;
      rows.push(`- ${anchor.subjectName} → ${anchor.relation} → ${anchor.relatedName}`);
    }
  }
  return rows.join("\n");
}

export function buildIdentityCanonBlock(params: {
  messages: IdentityMessageLike[];
  knownNames?: string[];
  characterSources?: IdentityCharacterSource[];
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
