export type SpatialMessageLike = {
  role?: unknown;
  content?: unknown;
};

export type SpatialIdentity = {
  canonicalName?: unknown;
  aliases?: unknown;
};

export type SpatialResidenceFact = {
  subjectName: string;
  place: string;
  evidence: string;
  sourceOrder: number;
};

export type RelativeResidenceAnchor = {
  anchorName: string;
  direction: "아랫집" | "윗집";
  evidence: string;
  sourceOrder: number;
};

export type TemporarySpatialPlacement = {
  subjectName: string;
  location: string;
  companionNames: string[];
  purpose: "sleep" | "room";
  evidence: string;
  sourceOrder: number;
  sourceTurn: number;
};

export type CurrentSceneAnchor = {
  location: string;
  evidence: string;
  sourceOrder: number;
  sourceTurn: number;
};

export type SpatialCanonResult = {
  block: string;
  residences: SpatialResidenceFact[];
  relativeAnchors: RelativeResidenceAnchor[];
  temporaryPlacements: TemporarySpatialPlacement[];
  currentScene: CurrentSceneAnchor | null;
};

const RELATIVE_PLACE_PATTERN =
  String.raw`(?:아랫집|아래층(?:의?\s*집)?|밑(?:에|의)?\s*집|밑집|윗집|위층(?:의?\s*집)?|위(?:에|의)?\s*집)`;

const GENERIC_ANCHOR_STOPWORDS = new Set([
  "그녀",
  "그들",
  "누군가",
  "사람들",
  "주인공",
  "페르소나",
  "할아버지",
  "할머니",
  "아저씨",
  "아줌마",
  "선생님",
  "경비원",
  "우리",
  "저희",
  "아파트",
  "빌라",
  "주택",
  "건물",
  "단칸방",
  "바로",
  "현재",
]);

function cleanText(value: unknown, max = 240) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizedKey(value: unknown) {
  return cleanText(value, 100).toLocaleLowerCase("ko-KR");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripQuotedDialogue(text: string) {
  return String(text || "")
    .replace(/"[^"\n]{1,800}"/g, " ")
    .replace(/“[^”\n]{1,800}”/g, " ")
    .replace(/‘[^’\n]{1,800}’/g, " ")
    .replace(/'[^'\n]{1,800}'/g, " ")
    .replace(/```[\s\S]*?```/g, " ");
}

function sentenceAround(text: string, index: number) {
  const source = String(text || "");
  let start = index;
  while (start > 0 && !/[\n.!?。！？]/u.test(source[start - 1])) start -= 1;
  let end = index;
  while (end < source.length && !/[\n.!?。！？]/u.test(source[end])) end += 1;
  if (end < source.length) end += 1;
  return cleanText(source.slice(start, end), 220);
}

function normalizeDirection(value: string): "아랫집" | "윗집" {
  return /^(?:윗|위)/u.test(cleanText(value, 40)) ? "윗집" : "아랫집";
}

function aliasList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item, 80)).filter(Boolean);
  return String(value || "")
    .split(/[\n,;/|]+/u)
    .map((item) => cleanText(item, 80))
    .filter(Boolean);
}

function identityEntries(params: {
  knownNames?: unknown[];
  identities?: SpatialIdentity[];
  personaName?: unknown;
}) {
  const aliases = new Map<string, string>();
  const add = (aliasRaw: unknown, canonicalRaw: unknown) => {
    const alias = cleanText(aliasRaw, 80);
    const canonical = cleanText(canonicalRaw, 80);
    if (!alias || !canonical || alias.length < 2) return;
    aliases.set(normalizedKey(alias), canonical);
  };
  for (const rawName of params.knownNames || []) add(rawName, rawName);
  for (const identity of params.identities || []) {
    const canonical = cleanText(identity?.canonicalName, 80);
    add(canonical, canonical);
    for (const alias of aliasList(identity?.aliases)) add(alias, canonical);
  }
  add(params.personaName, params.personaName);
  return [...aliases.entries()]
    .map(([alias, canonicalName]) => ({ alias, canonicalName }))
    .sort((a, b) => b.alias.length - a.alias.length);
}

function collectGenericAnchors(text: string) {
  const output: Array<{ alias: string; canonicalName: string }> = [];
  const regex = new RegExp(
    String.raw`(?:^|[\s*()\[\],])([가-힣]{2,6}?|[A-Za-z][A-Za-z0-9_-]{1,19}?)(?:의\s*)?\s*(${RELATIVE_PLACE_PATTERN})`,
    "gu"
  );
  for (const match of text.matchAll(regex)) {
    const candidate = cleanText(match[1], 80);
    if (!candidate || GENERIC_ANCHOR_STOPWORDS.has(candidate)) continue;
    output.push({ alias: normalizedKey(candidate), canonicalName: candidate });
  }
  return output;
}

function focusContainsName(focusText: string, name: string) {
  const focus = String(focusText || "").toLocaleLowerCase("ko-KR");
  const key = normalizedKey(name);
  return Boolean(focus && key && focus.includes(key));
}

const SUBJECT_PARTICLE_PATTERN = String.raw`(?:이는|이가|은|는|이|가)?`;
const PAIR_CONNECTOR_PATTERN = String.raw`(?:이랑|랑|이와|와|과)`;
const TOGETHER_PATTERN = String.raw`(?:같이\s*(?:자|잘|잔다|자라|잠|있|쓰|사용)|한\s*방|같은\s*방)`;

function explicitRoomInClause(
  clause: string,
  identities: Array<{ alias: string; canonicalName: string }>
) {
  if (/안방/u.test(clause)) return "안방";
  for (const identity of identities) {
    const room = new RegExp(`${escapeRegex(identity.alias)}(?:이|가)?(?:의)?\\s*방`, "iu");
    if (room.test(clause)) return `${identity.canonicalName}의 방`;
  }
  const generic = clause.match(/(?:거실|창고|주방|침실|서재|욕실|화장실|베란다|지하실|다락방)/u);
  return generic?.[0] || "";
}

function sceneAnchorFromClause(
  clause: string,
  identities: Array<{ alias: string; canonicalName: string }>
) {
  for (const identity of identities) {
    const room = new RegExp(
      `${escapeRegex(identity.alias)}(?:이|가)?(?:의)?\\s*방\\s*(?:상황|장면|시점|내부)`,
      "iu"
    );
    if (room.test(clause)) return `${identity.canonicalName}의 방`;
  }
  const generic = clause.match(/(안방|거실|창고|주방|침실|서재|욕실|화장실|베란다|지하실|다락방)\s*(?:상황|장면|시점|내부)/u);
  return generic?.[1] || "";
}

/**
 * Builds a compact, always-on location canon from explicit user narration.
 * This is intentionally independent from event retrieval: an old residence
 * anchor must not disappear merely because the current search query uses
 * different words.
 */
export function buildSpatialCanon(params: {
  messages: SpatialMessageLike[];
  knownNames?: unknown[];
  identities?: SpatialIdentity[];
  personaName?: unknown;
  focusText?: unknown;
  maxRows?: number;
}): SpatialCanonResult {
  const identities = identityEntries(params);
  const personaName = cleanText(params.personaName, 80);
  const placementIdentities = [...identities];
  if (personaName) placementIdentities.push({ alias: "나", canonicalName: personaName });
  const residencesBySubject = new Map<string, SpatialResidenceFact>();
  const anchorsBySlot = new Map<string, RelativeResidenceAnchor>();
  const placementsBySubject = new Map<string, TemporarySpatialPlacement>();
  let currentScene: CurrentSceneAnchor | null = null;
  let userTurn = 0;

  for (let sourceOrder = 0; sourceOrder < (params.messages || []).length; sourceOrder += 1) {
    const message = params.messages[sourceOrder];
    if (String(message?.role || "").toLowerCase() !== "user") continue;
    userTurn += 1;
    const text = stripQuotedDialogue(String(message?.content || ""));
    if (!text.trim()) continue;

    const clauses = text
      .split(/[\n.!?。！？]+/u)
      .map((clause) => cleanText(clause, 500))
      .filter(Boolean);
    for (const clause of clauses) {
      const sceneLocation = sceneAnchorFromClause(clause, placementIdentities);
      if (sceneLocation) {
        currentScene = {
          location: sceneLocation,
          evidence: clause,
          sourceOrder,
          sourceTurn: userTurn,
        };
      }

      for (const left of placementIdentities) {
        for (const right of placementIdentities) {
          if (left.canonicalName === right.canonicalName) continue;
          const leftName = escapeRegex(left.alias);
          const rightName = escapeRegex(right.alias);
          const subjectThenCompanion = new RegExp(
            `${leftName}${SUBJECT_PARTICLE_PATTERN}\\s*.{0,36}?${rightName}${PAIR_CONNECTOR_PATTERN}\\s*.{0,24}?${TOGETHER_PATTERN}`,
            "iu"
          );
          const joinedSubjects = new RegExp(
            `${leftName}${PAIR_CONNECTOR_PATTERN}\\s*${rightName}${SUBJECT_PARTICLE_PATTERN}\\s*.{0,40}?(?:${TOGETHER_PATTERN}|(?:안방|거실|창고|주방|침실|서재|다락방)\\s*(?:쓰|사용|자))`,
            "iu"
          );
          const subjectMatch = clause.match(subjectThenCompanion);
          const joinedMatch = subjectMatch ? null : clause.match(joinedSubjects);
          const matchedAssignment = subjectMatch?.[0] || joinedMatch?.[0] || "";
          if (!matchedAssignment) continue;
          const crossesAnotherNamedPerson = placementIdentities.some(
            (identity) =>
              identity.canonicalName !== left.canonicalName &&
              identity.canonicalName !== right.canonicalName &&
              identity.alias.length >= 2 &&
              matchedAssignment.toLocaleLowerCase("ko-KR").includes(identity.alias)
          );
          if (crossesAnotherNamedPerson) continue;

          const location = explicitRoomInClause(matchedAssignment, placementIdentities) || `${right.canonicalName}의 방`;
          const purpose = /(?:자|잘|잔다|자라|잠)/u.test(matchedAssignment) ? "sleep" : "room";
          const leftPlacement: TemporarySpatialPlacement = {
            subjectName: left.canonicalName,
            location,
            companionNames: [right.canonicalName],
            purpose,
            evidence: clause,
            sourceOrder,
            sourceTurn: userTurn,
          };
          const rightPlacement: TemporarySpatialPlacement = {
            ...leftPlacement,
            subjectName: right.canonicalName,
            companionNames: [left.canonicalName],
          };
          placementsBySubject.set(normalizedKey(left.canonicalName), leftPlacement);
          placementsBySubject.set(normalizedKey(right.canonicalName), rightPlacement);
        }
      }
    }

    const entries = [...identities, ...collectGenericAnchors(text)];
    const seenAliases = new Set<string>();
    const normalizedText = text.toLocaleLowerCase("ko-KR");
    for (const identity of entries) {
      if (!identity.alias || seenAliases.has(identity.alias)) continue;
      seenAliases.add(identity.alias);
      if (!normalizedText.includes(identity.alias)) continue;
      const escapedName = escapeRegex(identity.alias);

      const relativeRegex = new RegExp(
        String.raw`${escapedName}(?:의\s*)?\s*(${RELATIVE_PLACE_PATTERN})`,
        "giu"
      );
      for (const match of normalizedText.matchAll(relativeRegex)) {
        const direction = normalizeDirection(match[1]);
        const evidence = sentenceAround(text, match.index || 0);
        if (!evidence) continue;
        anchorsBySlot.set(`${normalizedKey(identity.canonicalName)}\u0000${direction}`, {
          anchorName: identity.canonicalName,
          direction,
          evidence,
          sourceOrder,
        });
      }

      const residenceRegex = new RegExp(
        String.raw`${escapedName}(?:은|는|이|가)\s+([^\n.!?。！？]{1,100}?(?:집|자택|거처|방|아파트|빌라|주택|기숙사|단칸방|오피스텔|\d+층)[^\n.!?。！？]{0,40}?)(?:에|에서)\s*(?:살(?:고|며|았|아|게|지|던|다)|거주(?:하|했|한|중))`,
        "giu"
      );
      for (const match of normalizedText.matchAll(residenceRegex)) {
        const place = cleanText(match[1], 120);
        const evidence = sentenceAround(text, match.index || 0);
        if (!place || !evidence) continue;
        residencesBySubject.set(normalizedKey(identity.canonicalName), {
          subjectName: identity.canonicalName,
          place,
          evidence,
          sourceOrder,
        });
      }
    }
  }

  const allResidences = [...residencesBySubject.values()].sort(
    (a, b) => a.sourceOrder - b.sourceOrder
  );
  const allAnchors = [...anchorsBySlot.values()].sort(
    (a, b) => a.sourceOrder - b.sourceOrder
  );
  const temporaryPlacements = [...placementsBySubject.values()].sort(
    (a, b) => a.sourceOrder - b.sourceOrder || a.subjectName.localeCompare(b.subjectName, "ko-KR")
  );
  const focusText = cleanText(params.focusText, 20_000);
  const maxRows = Math.max(4, Math.min(80, Math.trunc(Number(params.maxRows) || 24)));
  const isFocused = (name: string) =>
    normalizedKey(name) === normalizedKey(personaName) || focusContainsName(focusText, name);
  const prioritized = [
    ...allResidences.filter((fact) => isFocused(fact.subjectName)),
    ...allAnchors.filter((fact) => isFocused(fact.anchorName)),
    ...allResidences.slice(-8),
    ...allAnchors.slice(-16),
  ];
  const selected = new Map<string, SpatialResidenceFact | RelativeResidenceAnchor>();
  for (const fact of prioritized) {
    const key = "direction" in fact
      ? `anchor:${normalizedKey(fact.anchorName)}:${fact.direction}`
      : `residence:${normalizedKey(fact.subjectName)}`;
    selected.set(key, fact);
  }
  const selectedFacts = [...selected.values()]
    .sort((a, b) => a.sourceOrder - b.sourceOrder)
    .slice(-maxRows);

  const rows = [
    "# [공간 정본 — 사건 검색·AI 지문보다 우선]",
    "- 각 인물의 거주지는 서로 독립된 장소 노드다. 사용자가 같은 건물·같은 집이라고 명시하지 않은 두 거주지를 임의로 합치지 않는다.",
    "- 'A의 아랫집/윗집'은 오직 A의 거주지를 기준으로 한 상대 위치다. 현재 시점 인물이나 주인공의 집으로 그 이웃 관계를 옮겨 붙이지 않는다.",
    "- 방문·잠입·숙박·현재 장면의 위치는 거주지 변경이 아니다. 이사는 사용자의 명시적 변경이 있을 때만 최신 거주지로 갱신한다.",
    "- 임시 방 배정·동행·취침 지정은 거주지와 별개지만, 사용자가 다시 바꾸거나 명시적으로 퇴장시키기 전까지 현재 장면 구성보다 우선한다.",
    "- 사용자 확정 공간 관계와 충돌하는 이전 AI 지문은 오기이므로 이어받지 않는다.",
  ];
  if (currentScene) {
    rows.push(`- 현재 장면 위치: ${currentScene.location} (사용자 ${currentScene.sourceTurn}턴 근거: ${currentScene.evidence})`);
  }
  for (const placement of temporaryPlacements) {
    rows.push(
      `- ${placement.subjectName}의 임시 위치: ${placement.location}; 함께 있는 인물: ${placement.companionNames.join(", ")} (사용자 ${placement.sourceTurn}턴 근거: ${placement.evidence})`
    );
  }
  for (const fact of selectedFacts) {
    if ("direction" in fact) {
      rows.push(
        `- ${fact.anchorName}의 ${fact.direction}: ${fact.evidence} (이웃 관계의 기준은 반드시 ${fact.anchorName}의 거주지)`
      );
    } else {
      rows.push(`- ${fact.subjectName}의 거주지: ${fact.place} (사용자 근거: ${fact.evidence})`);
    }
  }

  return {
    block: rows.join("\n"),
    residences: allResidences,
    relativeAnchors: allAnchors,
    temporaryPlacements,
    currentScene,
  };
}
