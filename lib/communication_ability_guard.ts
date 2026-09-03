export type CommunicationIdentityLike = {
  name?: unknown;
  aliases?: unknown;
  role?: unknown;
  profile?: unknown;
  relationshipNote?: unknown;
  emotionNote?: unknown;
  status?: unknown;
};

export type CommunicationFactLike = {
  subjectName?: unknown;
  factKey?: unknown;
  value?: unknown;
  sourceRole?: unknown;
};

export type CommunicationConstraint = {
  name: string;
  aliases: string[];
  mode: "writing" | "sign" | "gesture" | "nonverbal";
  evidence: string;
};

const NONVERBAL_RE =
  /(?:말(?:을)?\s*(?:하지\s*못|못하|할\s*수\s*(?:없|없는))|음성\s*(?:발화|대화)\s*(?:불가|불능)|발화\s*(?:불가|불능)|실어증|무언증|목소리(?:를|가)?\s*(?:낼|내지|나오지)\s*수\s*없)/u;
const WRITING_RE = /(?:스케치북|필담|글씨로\s*의사소통|글로\s*의사소통)/u;
const SIGN_RE = /(?:수어|수화)(?:로|를|만|\s*사용)/u;
const GESTURE_RE = /(?:몸짓|제스처)(?:로|를|만|\s*사용)/u;

function cleanText(value: unknown, max = 1000) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function splitAliases(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return [] as string[];
  const aliases: string[] = [];
  try {
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.aliases)
        ? parsed.aliases
        : [];
    for (const item of source) {
      const alias = cleanText(item, 80);
      if (alias) aliases.push(alias);
    }
  } catch {
    for (const item of raw.split(/[\n,;\/|]+/g)) {
      const alias = cleanText(item, 80);
      if (alias) aliases.push(alias);
    }
  }
  return [...new Set(aliases)];
}

function methodFromEvidence(evidence: string): CommunicationConstraint["mode"] {
  if (WRITING_RE.test(evidence)) return "writing";
  if (SIGN_RE.test(evidence)) return "sign";
  if (GESTURE_RE.test(evidence)) return "gesture";
  return "nonverbal";
}

export function buildCommunicationConstraints(params: {
  identities?: CommunicationIdentityLike[];
  facts?: CommunicationFactLike[];
}) {
  const constraints = new Map<string, CommunicationConstraint>();
  const factsByName = new Map<string, string[]>();
  for (const fact of params.facts || []) {
    const name = cleanText(fact?.subjectName, 80);
    const value = cleanText(fact?.value, 1000);
    if (!name || !value) continue;
    const key = name.toLocaleLowerCase("ko-KR");
    const list = factsByName.get(key) || [];
    list.push(value);
    factsByName.set(key, list);
  }

  for (const identity of params.identities || []) {
    const name = cleanText(identity?.name, 80);
    if (!name) continue;
    const aliases = splitAliases(identity?.aliases).filter((alias) => alias !== name);
    const evidence = [
      identity?.role,
      identity?.profile,
      identity?.relationshipNote,
      identity?.emotionNote,
      identity?.status,
      ...(factsByName.get(name.toLocaleLowerCase("ko-KR")) || []),
    ]
      .map((value) => cleanText(value, 1000))
      .filter(Boolean)
      .join(" | ");
    // Hearing loss alone does not imply an inability to speak. Only an explicit
    // speech limitation establishes this hard constraint.
    if (!NONVERBAL_RE.test(evidence)) continue;
    constraints.set(name.toLocaleLowerCase("ko-KR"), {
      name,
      aliases,
      mode: methodFromEvidence(evidence),
      evidence,
    });
  }

  return [...constraints.values()];
}

export function formatCommunicationAbilityBlock(
  constraints: CommunicationConstraint[]
) {
  if (!constraints.length) return "";
  return [
    "# [발화 능력 정사 — 직접 대사 분량 규칙보다 우선]",
    "- 아래 인물은 음성 직접 대사(\"...\")를 절대 출력하지 않는다. 직접 지목되거나 대답이 필요한 장면이어도 예외가 아니다.",
    "- 해당 인물의 반응은 설정된 의사소통 방식, 표정, 시선, 행동으로 표현한다. 말문을 새로 회복시키거나 소리쳤다고 쓰지 않는다.",
    ...constraints.map((constraint) => {
      const method =
        constraint.mode === "writing"
          ? "스케치북/필담"
          : constraint.mode === "sign"
            ? "수어"
            : constraint.mode === "gesture"
              ? "몸짓"
              : "비음성 표현";
      return `- ${constraint.name}: 음성 발화 불가, 의사소통=${method}`;
    }),
  ].join("\n");
}

function reEsc(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findConstraintSubject(
  narration: string,
  constraints: CommunicationConstraint[]
) {
  const text = String(narration || "");
  let picked: { constraint: CommunicationConstraint; index: number } | null = null;
  for (const constraint of constraints) {
    for (const name of [constraint.name, ...constraint.aliases]) {
      const pattern = new RegExp(
        `${reEsc(name)}(?:(?:은|는|이|가|도)(?=\\s|[,.:;!?。！？*]|$)|\\s+(?:역시|또한)(?=\\s|[,.:;!?。！？*]|$))`,
        "gu"
      );
      for (const match of text.matchAll(pattern)) {
        const index = Number(match.index || 0);
        if (!picked || index > picked.index) picked = { constraint, index };
      }
    }
  }
  return picked?.constraint || null;
}

function writtenReaction(constraint: CommunicationConstraint, content: string) {
  const cleaned = cleanText(content, 1200).replace(/[\[\]]/g, "");
  if (constraint.mode === "writing") {
    return `*${constraint.name}는 스케치북에 [${cleaned}]라고 적어 보였다.*`;
  }
  if (constraint.mode === "sign") {
    return `*${constraint.name}는 수어로 [${cleaned}]라는 뜻을 전했다.*`;
  }
  if (constraint.mode === "gesture") {
    return `*${constraint.name}는 말 대신 몸짓으로 [${cleaned}]라는 뜻을 전했다.*`;
  }
  return `*${constraint.name}는 입을 열지 않고 표정과 몸짓으로 의사를 전했다.*`;
}

export function enforceCommunicationAbilities(params: {
  text: unknown;
  contextText?: unknown;
  constraints: CommunicationConstraint[];
}) {
  const source = String(params.text || "");
  if (!source || !params.constraints.length) {
    return { text: source, rewritten: 0, characterNames: [] as string[] };
  }

  const parts = source.split(/(\r?\n(?:[ \t]*\r?\n)+)/u);
  const contextParagraphs = String(params.contextText || "")
    .split(/\r?\n(?:[ \t]*\r?\n)*/u)
    .map((value) => value.trim())
    .filter(Boolean);
  let active = contextParagraphs.length
    ? findConstraintSubject(contextParagraphs.at(-1) || "", params.constraints)
    : null;
  let rewritten = 0;
  const characterNames = new Set<string>();

  for (let index = 0; index < parts.length; index += 2) {
    const paragraph = parts[index];
    const trimmed = paragraph.trim();
    if (!trimmed || trimmed.startsWith("```")) continue;
    const dialogue = trimmed.match(/^["“]([\s\S]*?)["”]$/u);
    if (dialogue) {
      let speaker = active;
      if (!speaker) {
        const nextParagraph = String(parts[index + 2] || "").trim();
        if (/(?:말했|말하|외쳤|소리쳤|대답했|속삭였|입을\s*열|목소리)/u.test(nextParagraph)) {
          speaker = findConstraintSubject(nextParagraph, params.constraints);
        }
      }
      if (speaker) {
        const leading = paragraph.match(/^\s*/u)?.[0] || "";
        const trailing = paragraph.match(/\s*$/u)?.[0] || "";
        parts[index] = `${leading}${writtenReaction(speaker, dialogue[1])}${trailing}`;
        rewritten += 1;
        characterNames.add(speaker.name);
      }
      continue;
    }

    // A new narration paragraph changes the implied speaker. Clearing the old
    // subject prevents a later father's dialogue from being assigned to the
    // nonverbal character merely because she appeared earlier in the scene.
    active = findConstraintSubject(trimmed, params.constraints);
  }

  return {
    text: parts.join(""),
    rewritten,
    characterNames: [...characterNames],
  };
}
