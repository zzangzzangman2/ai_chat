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
};

export type EpistemicPromptFirewall = {
  facts: ProtectedRelationshipFact[];
  worldOnlyRelationIds: Set<string>;
};

export type EpistemicSanitizeResult = {
  text: string;
  redactedSegments: number;
};

function cleanText(value: unknown, max = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function nameKey(value: unknown) {
  return cleanText(value, 100).toLocaleLowerCase("ko-KR");
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
  return sanitizeEpistemicText(
    value,
    firewall.facts.filter((fact) => fact.knownByNames.length === 0)
  );
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
