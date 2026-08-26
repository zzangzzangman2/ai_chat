import {
  inferRelationshipKnownByNames,
  isConfidentialRelationshipKnowledge,
} from "@/lib/character_knowledge";
import type {
  RelationshipGraphData,
  RelationshipGraphRelation,
} from "@/lib/relationship_graph";

export type ProtectedRelationshipFact = {
  relationId: string;
  subjectName: string;
  objectName: string;
  relation: string;
  details: string;
  knownByNames: string[];
  knowledgeEvidence: string;
};

export type EpistemicPromptFirewall = {
  facts: ProtectedRelationshipFact[];
  worldOnlyRelationIds: Set<string>;
};

export type EpistemicSanitizeResult = {
  text: string;
  redactedSegments: number;
};

export type GeneratedEpistemicOptions = {
  groundedFactIds?: ReadonlySet<string>;
};

function splitLineSentences(line: string) {
  const marked = String(line || "").replace(
    /([.!?。！？](?:["”']|\*+)?)(\s+)/gu,
    "$1\u0000"
  );
  return marked.split("\u0000").map((part) => part.trim()).filter(Boolean);
}

function restoreOuterNarrationMarkers(original: string, value: string) {
  let output = String(value || "").trim();
  if (!output) return "";
  const source = String(original || "").trim();
  if (source.startsWith("*") && !output.startsWith("*")) output = `*${output}`;
  if (source.endsWith("*") && !output.endsWith("*")) output = `${output}*`;
  return output;
}

function cleanText(value: unknown, max = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function nameKey(value: unknown) {
  return cleanText(value, 100).toLocaleLowerCase("ko-KR");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contentTokens(value: unknown) {
  const stop = new Set([
    "관계",
    "사건",
    "상태",
    "인물",
    "현재",
    "과거",
    "사람",
    "서로",
  ]);
  return new Set(
    (String(value || "").match(/[가-힣A-Za-z0-9]{2,}/gu) || [])
      .map((token) => token.toLocaleLowerCase("ko-KR"))
      .filter((token) => !stop.has(token))
  );
}

function toProtectedFact(
  relation: RelationshipGraphRelation
): ProtectedRelationshipFact | null {
  const relationText = cleanText(relation.relation, 300);
  const details = cleanText(relation.objectRole, 1200);
  if (!isConfidentialRelationshipKnowledge(`${relationText} ${details}`)) return null;

  const knownByNames = inferRelationshipKnownByNames({
    subjectName: relation.subjectName,
    objectName: relation.objectName,
    relation: relationText,
    details,
    storedKnownByNames: relation.knownByNames,
  });
  return {
    relationId: String(relation.id || ""),
    subjectName: cleanText(relation.subjectName, 100),
    objectName: cleanText(relation.objectName, 100),
    relation: relationText,
    details,
    knownByNames,
    knowledgeEvidence: cleanText(relation.knowledgeEvidence, 1200),
  };
}

export function buildEpistemicPromptFirewall(
  graph: RelationshipGraphData
): EpistemicPromptFirewall {
  const facts = graph.relations
    .map(toProtectedFact)
    .filter(Boolean) as ProtectedRelationshipFact[];
  return {
    facts,
    worldOnlyRelationIds: new Set(
      facts.filter((fact) => fact.knownByNames.length === 0).map((fact) => fact.relationId)
    ),
  };
}

export function omitWorldOnlyRelationshipsFromPrompt(
  graph: RelationshipGraphData,
  firewall: EpistemicPromptFirewall
): RelationshipGraphData {
  if (firewall.worldOnlyRelationIds.size === 0) return graph;
  return {
    ...graph,
    relations: graph.relations.filter(
      (relation) => !firewall.worldOnlyRelationIds.has(String(relation.id || ""))
    ),
  };
}

function segmentAssertsProtectedFact(
  segment: string,
  fact: ProtectedRelationshipFact
) {
  // Some leaks state only an indirect conclusion (for example that an unnamed
  // defendant was framed) and omit the hidden actor's name entirely. These are
  // still knowledge claims, not neutral scene observations.
  if (
    /(?:(?:억울하게\s*)?누명을\s*(?:쓴|썼|쓰고|뒤집어쓴|씌운|씌웠)|무고한\s*(?:피고인|용의자|사람)|죄가\s*없(?:다|었|는)|범행과\s*무관|원흉|진범|진짜\s*(?:범인|가해자)|실제\s*(?:범인|가해자)|숨은\s*(?:범인|배후|정체)|비밀\s*(?:정체|관계)|알리바이\s*(?:조작|위조)|배후가\s*(?:따로|있)|공모자)/u.test(
      segment
    )
  ) {
    return true;
  }
  const normalized = segment.toLocaleLowerCase("ko-KR");
  const subject = nameKey(fact.subjectName);
  const object = nameKey(fact.objectName);
  const details = nameKey(fact.details);
  const subjectIndex = subject ? details.indexOf(subject) : -1;
  const objectIndex = object ? details.indexOf(object) : -1;
  // Structured relation details normally begin with the person whose hidden
  // action/identity is being asserted. Use that topic endpoint as the anchor so
  // a public discussion of the victim or relative alone is not erased.
  const primaryAnchor =
    objectIndex >= 0 && (subjectIndex < 0 || objectIndex < subjectIndex)
      ? object
      : subject || object;
  const anchors = [primaryAnchor].filter((name) => name.length >= 2);
  if (!anchors.some((name) => normalized.includes(name))) return false;

  // Sensitive conclusions such as culprit, framing, hidden identity, or a secret
  // act must never be inherited from shared summaries or prior model narration.
  if (
    /(?:누명|원흉|진범|진짜\s*(?:범인|가해자)|실제\s*(?:범인|가해자)|범행의?\s*(?:주체|배후)|비밀\s*(?:정체|관계)|몰래\s*(?:침입|촬영|도청)|불법\s*촬영|성폭|강간|살인|납치|유괴|공모|배후|범(?:했|하고|한))/u.test(
      segment
    )
  ) {
    return true;
  }

  const factTokens = contentTokens(`${fact.relation} ${fact.details}`);
  for (const anchor of anchors) factTokens.delete(anchor);
  const segmentTokens = contentTokens(segment);
  let overlap = 0;
  for (const token of factTokens) {
    if (!segmentTokens.has(token)) continue;
    overlap += 1;
    if (overlap >= 2) return true;
  }
  return false;
}

function segmentAttributesKnowledge(value: unknown) {
  const text = String(value || "").trim();
  return (
    /^["“]/u.test(text) ||
    /(?:알고\s*있|알고\s*있었|알았|안다|아는\s*(?:사실|눈치)|깨달|눈치챘|인지했|파악했|확신했|기억했|정체를\s*알|사실을\s*알)/u.test(text)
  );
}

/**
 * Finds confidential relationship facts that are already established by the
 * user or by stored narration. A grounded world fact may remain in neutral
 * narration, but it still cannot be promoted to an NPC's personal knowledge.
 */
export function buildGroundedEpistemicFactIds(
  firewall: EpistemicPromptFirewall,
  trustedTexts: unknown[]
) {
  const grounded = new Set<string>();
  const segments = (trustedTexts || []).flatMap((value) =>
    String(value || "")
      .split(/\r?\n/u)
      .flatMap(splitLineSentences)
      .filter(Boolean)
  );
  for (const fact of firewall.facts) {
    const subject = nameKey(fact.subjectName);
    const object = nameKey(fact.objectName);
    const supported = segments.some((segment) => {
      const normalized = segment.toLocaleLowerCase("ko-KR");
      if (
        !(subject && normalized.includes(subject)) &&
        !(object && normalized.includes(object))
      ) {
        return false;
      }
      return segmentAssertsProtectedFact(segment, fact);
    });
    if (supported) grounded.add(fact.relationId);
  }
  return grounded;
}

function normalizeAfterRedaction(value: string) {
  return value
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitPromptSections(source: string) {
  const heading = /^###\s+.*$/gmu;
  const matches = [...source.matchAll(heading)];
  if (matches.length === 0) return [source];

  const sections: string[] = [];
  const prefix = source.slice(0, Number(matches[0].index || 0)).trim();
  if (prefix) sections.push(prefix);
  for (let index = 0; index < matches.length; index += 1) {
    const start = Number(matches[index].index || 0);
    const end =
      index + 1 < matches.length
        ? Number(matches[index + 1].index || source.length)
        : source.length;
    const section = source.slice(start, end).trim();
    if (section) sections.push(section);
  }
  return sections;
}

/**
 * Removes unsupported secret assertions from a shared prompt view. Stored chat
 * messages and summaries remain untouched; only the text sent to the model is
 * filtered. Section/turn-level removal also catches conclusions whose subject
 * is carried by a heading or an adjacent paragraph in the same memory section.
 */
function sanitizeEpistemicText(
  value: unknown,
  facts: ProtectedRelationshipFact[]
): EpistemicSanitizeResult {
  const source = String(value || "");
  if (!source.trim() || facts.length === 0) {
    return { text: source.trim(), redactedSegments: 0 };
  }

  let redactedSegments = 0;
  const sanitized = splitPromptSections(source)
    .map((segment) => {
      if (!segment.trim()) return "";
      if (!facts.some((fact) => segmentAssertsProtectedFact(segment, fact))) {
        return segment.trim();
      }
      redactedSegments += 1;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  return { text: normalizeAfterRedaction(sanitized), redactedSegments };
}

export function sanitizeSharedEpistemicText(
  value: unknown,
  firewall: EpistemicPromptFirewall
): EpistemicSanitizeResult {
  // Shared summaries have no single reader. A limited fact that is safe for
  // one witness is still unsafe for every other NPC, so keep every confidential
  // relationship out of this common prompt view. Authorized characters receive
  // their own scoped memories separately.
  return sanitizeEpistemicText(value, firewall.facts);
}

export function sanitizeCharacterEpistemicText(
  value: unknown,
  characterName: unknown,
  firewall: EpistemicPromptFirewall
): EpistemicSanitizeResult {
  const character = nameKey(characterName);
  const restrictedFacts = firewall.facts.filter(
    (fact) => !fact.knownByNames.some((name) => nameKey(name) === character)
  );
  return sanitizeEpistemicText(value, restrictedFacts);
}

/**
 * Recent assistant turns are already divided into individual messages by the
 * caller. Removing a whole message when one sentence contains a protected
 * conclusion erases the model's immediate scene continuity, so use the
 * sentence-level output sanitizer for this prompt view. Summary blocks keep
 * using sanitizeSharedEpistemicText because their headings can carry context
 * across adjacent sentences.
 */
export function sanitizeRecentAssistantEpistemicText(
  value: unknown,
  firewall: EpistemicPromptFirewall
): EpistemicSanitizeResult {
  return sanitizeGeneratedEpistemicText(value, firewall);
}

const KNOWLEDGE_SPEECH_PATTERN =
  /(?:말했|말하|대답|설명|알렸|밝혔|보고|전했|경고|외쳤|속삭|물었|입을\s*열|목소리)/u;

const GENERIC_SPEAKER_ROLE_PATTERN =
  /(?:경찰관?|형사|수사관|검사|교사|선생|기자|의사|간호사|공무원)/u;

const PUBLIC_DISCLOSURE_PATTERN =
  /(?:법정|재판|공판|검사|기소|선고|판결|수사|경찰|신고|진술|자백|보도|뉴스|수배|체포|구속|공개|발표|구출|증거)/u;

const SECRET_SEMANTIC_PATTERNS = [
  /(?:유린|성폭|강간|성착취|추행|능욕)/u,
  /(?:인질|볼모)/u,
  /(?:납치|유괴|감금)/u,
  /(?:협박|강요|위협)/u,
  /(?:살인|살해|사망|죽였)/u,
  /(?:가족|일가족|부모|아들|딸)/u,
  /(?:미성년|여중생|여고생|소녀|소년|학생)/u,
] as const;

type KnowledgeSpeakerHint = {
  name: string;
  role: string;
};

function inferKnowledgeSpeaker(
  value: string,
  facts: ProtectedRelationshipFact[]
): KnowledgeSpeakerHint | null {
  const text = String(value || "");
  if (!text.trim()) return null;
  const names = [
    ...new Set(
      facts.flatMap((fact) => [
        fact.subjectName,
        fact.objectName,
        ...fact.knownByNames,
      ])
    ),
  ]
    .filter((name) => name.length >= 2)
    .sort((a, b) => b.length - a.length);
  if (KNOWLEDGE_SPEECH_PATTERN.test(text)) {
    for (const name of names) {
      const pattern = new RegExp(
        `${escapeRegex(name)}(?:은|는|이|가|도)?[^.!?。！？\\n]{0,80}(?:${KNOWLEDGE_SPEECH_PATTERN.source})`,
        "iu"
      );
      if (pattern.test(text)) return { name, role: "" };
    }
  }
  const role = GENERIC_SPEAKER_ROLE_PATTERN.exec(text)?.[0] || "";
  return role ? { name: "", role } : null;
}

function semanticSignature(value: unknown) {
  const text = String(value || "");
  return SECRET_SEMANTIC_PATTERNS.map((pattern, index) =>
    pattern.test(text) ? index : -1
  ).filter((index) => index >= 0);
}

function looselyAssertsProtectedFact(
  segment: string,
  fact: ProtectedRelationshipFact,
  allFacts: ProtectedRelationshipFact[]
) {
  const segmentSignature = new Set(semanticSignature(segment));
  const factSignature = semanticSignature(`${fact.relation} ${fact.details}`);
  let overlap = 0;
  for (const key of factSignature) {
    if (segmentSignature.has(key)) overlap += 1;
  }
  if (overlap < 3) return false;

  const relatedNames = new Set(
    [fact.subjectName, fact.objectName, ...fact.knownByNames].map(nameKey)
  );
  const allNames = [
    ...new Set(
      allFacts.flatMap((item) => [
        item.subjectName,
        item.objectName,
        ...item.knownByNames,
      ])
    ),
  ].filter((name) => name.length >= 2);
  const mentionedOtherName = allNames.some(
    (name) =>
      segment.includes(name) && !relatedNames.has(nameKey(name))
  );
  return !mentionedOtherName;
}

function factIsPubliclyDisclosed(fact: ProtectedRelationshipFact) {
  const text = `${fact.relation} ${fact.details} ${fact.knowledgeEvidence}`;
  if (
    /(?:신고|수사기관에\s*전달|경찰에\s*전달|공개|발각)[^.!?。！？\n]{0,20}(?:되지\s*않|되지\s*못|안\s*됐|없)|아직[^.!?。！？\n]{0,30}(?:신고|수사|공개|발각)[^.!?。！？\n]{0,15}(?:전|되지\s*않|못)/u.test(
      text
    )
  ) {
    return false;
  }
  return PUBLIC_DISCLOSURE_PATTERN.test(text);
}

function speakerMayKnowFact(
  speaker: KnowledgeSpeakerHint | null,
  fact: ProtectedRelationshipFact
) {
  if (factIsPubliclyDisclosed(fact)) return true;
  if (!speaker) return false;
  const allowed = fact.knownByNames.map(nameKey);
  if (speaker.name && allowed.includes(nameKey(speaker.name))) return true;
  if (
    speaker.role &&
    allowed.some((name) =>
      /(?:경찰|형사|수사관|검사|교사|선생|기자|의사|간호사|공무원)/u.test(name) &&
      (name.includes(speaker.role) || speaker.role.includes(name))
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Final-response backstop. Unlike shared-memory sanitization, this removes only
 * the individual generated sentences that assert a world-only confidential
 * fact so the rest of the scene and its observable details remain intact.
 */
export function sanitizeGeneratedEpistemicText(
  value: unknown,
  firewall: EpistemicPromptFirewall,
  options: GeneratedEpistemicOptions = {}
): EpistemicSanitizeResult {
  const source = String(value || "");
  const facts = firewall.facts;
  if (!source.trim() || facts.length === 0) {
    return { text: source, redactedSegments: 0 };
  }

  let redactedSegments = 0;
  let inFence = false;
  let speakerHint: KnowledgeSpeakerHint | null = null;
  const lines = source.split(/\r?\n/u).map((line) => {
    if (/^\s*```/u.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence || !line.trim()) return line;

    const lineSpeaker = inferKnowledgeSpeaker(line, facts);
    if (lineSpeaker) speakerHint = lineSpeaker;
    const directDialogue = /^[\s*]*["“]/u.test(line);
    const attributedSpeaker = directDialogue ? speakerHint : lineSpeaker;

    const kept = splitLineSentences(line).filter((sentence) => {
      const attributesKnowledge = directDialogue || segmentAttributesKnowledge(sentence);
      const unsupported = facts.some((fact) => {
        if (
          !segmentAssertsProtectedFact(sentence, fact) &&
          !looselyAssertsProtectedFact(sentence, fact, facts)
        ) {
          return false;
        }
        const grounded = options.groundedFactIds?.has(fact.relationId) === true;
        if (fact.knownByNames.length === 0) return !grounded || attributesKnowledge;
        return attributesKnowledge && !speakerMayKnowFact(attributedSpeaker, fact);
      });
      if (unsupported) redactedSegments += 1;
      return !unsupported;
    });
    return restoreOuterNarrationMarkers(line, kept.join(" "));
  });

  if (redactedSegments === 0) {
    return { text: source, redactedSegments: 0 };
  }

  return {
    text: normalizeAfterRedaction(lines.join("\n")),
    redactedSegments,
  };
}
