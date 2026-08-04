import {
  extractSummarySections,
  type StoredSummarySection,
} from "./summaryStored";

export type ContinuityIdentity = {
  name: string;
  aliases?: string;
  role?: string;
  profile?: string;
  relationshipNote?: string;
  emotionNote?: string;
  status?: string;
};

export type PersistentContinuityStateKind =
  | "surveillance"
  | "protection"
  | "pursuit"
  | "detained"
  | "hospitalized"
  | "assignment";

export type ContinuityStateKind =
  | "deceased"
  | "reported_deceased"
  | "missing"
  | "alive"
  | PersistentContinuityStateKind;

export type ContinuityState = {
  name: string;
  kind: ContinuityStateKind;
  startTurn: number;
  endTurn: number;
  title: string;
  detail?: string;
  lastConfirmedTurn?: number;
};

type StateMatch = { kind: ContinuityStateKind; index: number; priority: number };

const STATE_LABEL: Record<ContinuityStateKind, string> = {
  deceased: "사망 확정",
  reported_deceased: "사망 처리됨(이후 생존 확인 없음)",
  missing: "실종/행방불명",
  alive: "생존 확인",
  surveillance: "감시/잠복 임무 진행 중",
  protection: "경호/보호 임무 진행 중",
  pursuit: "추적/수색 진행 중",
  detained: "구금/수감 상태",
  hospitalized: "입원/병원 치료 중",
  assignment: "담당/배치 임무 진행 중",
};

type PersistentEvent = {
  kind: PersistentContinuityStateKind;
  action: "start" | "end";
  index: number;
  detail: string;
  target?: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identityNames(identity: ContinuityIdentity) {
  const values = [identity.name, ...String(identity.aliases || "").split(/[,/|;\n]+/)]
    .map((value) => value.trim())
    .filter((value) => value.length >= 2);
  return Array.from(new Set(values)).sort((a, b) => b.length - a.length);
}

function compactDetail(value: string, max = 180) {
  const cleaned = String(value || "")
    .replace(/^\s*[-*•]+\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trim()}…` : cleaned;
}

function textSegments(text: string) {
  const segments: Array<{ text: string; index: number }> = [];
  const source = String(text || "");
  for (const match of source.matchAll(/[^\n.!?。！？,，;；]+(?:[.!?。！？,，;；]+|$)/gu)) {
    const value = String(match[0] || "").trim();
    if (!value) continue;
    segments.push({ text: value, index: Number(match.index || 0) });
  }
  return segments;
}

const AGENT_ROLE =
  "(?:사복\\s*)?(?:형사|경찰|수사관|요원|경호원|경비원|대원|간호사|의사|직원)|감시\\s*(?:팀|조|반)|경호\\s*(?:팀|조)|수사\\s*(?:팀|조)|순찰\\s*(?:팀|조)|전담\\s*(?:팀|조)|담당자";

const OPERATION_TERM: Record<Exclude<PersistentContinuityStateKind, "detained" | "hospitalized">, string> = {
  surveillance: "(?:감시|주시|미행|잠복)",
  protection: "(?:경호|호위|신변\\s*보호|보호\\s*임무)",
  pursuit: "(?:추적|수색|추격)",
  assignment: "(?:담당|전담|임무|배치|파견|당번|근무)",
};

const OPERATION_END = "(?:해제|중단|종료|취소|철회|그만|포기|철수|끝냈|끝남|끝났|마쳤)";

function hasNegatedOperationEnd(text: string) {
  return /(?:해제|중단|종료|취소|철회|포기|철수|끝내|마치)(?:하|되)?지\s*(?:않|못)/u.test(
    text
  );
}

function isDelegatingOperation(segment: string, rawName: string, term: string) {
  const name = escapeRegExp(rawName);
  const subject = `${name}(?:\\s*(?:${AGENT_ROLE}))?\\s*(?:은|는|이|가|도)`;
  return new RegExp(
    `${subject}[^.!?]{0,100}?(?:(?:에게|한테)[^.!?]{0,50})?${term}[^.!?]{0,24}(?:지시|명령|시키|맡겼|요청)`,
    "u"
  ).test(segment);
}

function hasPersistentOperationStart(
  segment: string,
  rawName: string,
  kind: "surveillance" | "protection" | "pursuit"
) {
  const name = escapeRegExp(rawName);
  const term = OPERATION_TERM[kind];
  const subject = `${name}(?:\\s*(?:${AGENT_ROLE}))?\\s*(?:은|는|이|가|도|[:：-])`;
  const persistent =
    `(?:(?:상주|밀착|지속|계속|전담|24\\s*시간|밤새|교대|배치|파견|이어받)[^.!?]{0,55}${term}` +
    `|${term}[^.!?]{0,40}(?:시작|계속|이어|유지|담당|맡|전담|중(?:이|임|인)?|나섰|하기로|배치|붙었)` +
    (kind === "surveillance" ? `|(?:잠복)(?:\\s*근무|에\\s*들어|을\\s*시작|했다|함)` : "") +
    `)`;
  const forward = new RegExp(`${subject}[^.!?]{0,150}?${persistent}`, "u").test(segment);
  const possessive = new RegExp(`${name}의\\s*${persistent}`, "u").test(segment);
  const reverse = new RegExp(
    `${term}[^.!?]{0,55}(?:중인|담당하는|맡은|이어받은|계속하는|배치된)\\s*${name}`,
    "u"
  ).test(segment);
  if (!(forward || possessive || reverse)) return false;
  if (/감시망\s*속|감시(?:를|를\s*계속)?\s*(?:받|당)|감시\s*대상/u.test(segment)) return false;
  if (kind === "protection") {
    // "형사는 신변 보호 중인 피해자라며 ..." identifies the protected
    // party; it does not say that the anonymous detective owns the protection
    // assignment. Require a separate duty/action predicate before treating
    // this attributive form as the actor's persistent state.
    const protectedPartyAttribution = new RegExp(
      `${term}\\s*중인\\s*(?:피해자|보호\\s*대상(?:자)?|대상자|신고자|목격자|민간인|환자|아이|여성|남성|주민)(?:이|가|은|는|을|를|라며|라고|임을|임에|임에도|[,.!?]|$)`,
      "u"
    ).test(segment);
    const actorDuty = new RegExp(
      `${subject}[^.!?]{0,150}?(?:지키|호위하|경호하|보호하|담당|맡|배치|파견|수행)`,
      "u"
    ).test(segment);
    if (protectedPartyAttribution && !actorDuty) return false;
  }
  return !isDelegatingOperation(segment, rawName, term);
}

function localContextForName(segment: string, rawName: string, allNames: string[]) {
  const nameAt = segment.indexOf(rawName);
  if (nameAt < 0) return segment;
  let end = segment.length;
  for (const otherName of allNames) {
    if (otherName === rawName) continue;
    const re = new RegExp(`${escapeRegExp(otherName)}(?:\\s*(?:${AGENT_ROLE}))?\\s*(?:은|는|이|가|도)`, "gu");
    for (const match of segment.matchAll(re)) {
      const index = Number(match.index || 0);
      if (index > nameAt) end = Math.min(end, index);
    }
  }
  const tail = segment.slice(nameAt + rawName.length, end);
  const switchedSubject = tail.search(
    /(?:했고|했으며|하며|하고|되었고|됐고|이며|이고|지만)\s+[가-힣A-Za-z][가-힣A-Za-z0-9·_-]{1,15}(?:은|는|이|가|도)\s/u
  );
  if (switchedSubject >= 0) end = Math.min(end, nameAt + rawName.length + switchedSubject);
  return segment.slice(nameAt, end).trim();
}

function hasPersistentOperationEnd(
  segment: string,
  rawName: string,
  kind: "surveillance" | "protection" | "pursuit" | "assignment"
) {
  if (hasNegatedOperationEnd(segment)) return false;
  const name = escapeRegExp(rawName);
  const term = OPERATION_TERM[kind];
  const subject = `${name}(?:\\s*(?:${AGENT_ROLE}))?\\s*(?:은|는|이|가|도|의|[:：-])`;
  const explicitClose = new RegExp(
    `${subject}[^.!?]{0,150}?(?:${term}[^.!?]{0,35}${OPERATION_END}|${OPERATION_END}[^.!?]{0,35}${term})`,
    "u"
  ).test(segment);
  const removed = new RegExp(
    `${name}(?:을|를|에게서|로부터)[^.!?]{0,90}(?:${term}[^.!?]{0,30})?(?:해제|제외|교체|철수|인계)`,
    "u"
  ).test(segment);
  const replaced = new RegExp(`${name}(?:와|과)\\s*교대|${name}\\s*대신`, "u").test(segment)
    && new RegExp(term, "u").test(segment);
  const handedOff = new RegExp(
    `${name}(?:\\s*(?:${AGENT_ROLE}))?\\s*(?:은|는|이|가)[^.!?]{0,120}${term}[^.!?]{0,35}(?:인계|넘겼|교체)`,
    "u"
  ).test(segment);
  const roleCarriesOperation =
    (kind === "surveillance" && /(?:감시|잠복)/u.test(rawName))
    || (kind === "protection" && /(?:경호|보호)/u.test(rawName))
    || (kind === "pursuit" && /(?:추적|수색|추격)/u.test(rawName))
    || (kind === "assignment" && /(?:감시|잠복|경호|보호|추적|수색|추격|전담|담당)/u.test(rawName));
  const roleClose = roleCarriesOperation && new RegExp(
    `${subject}[^.!?]{0,45}${OPERATION_END}`,
    "u"
  ).test(segment);
  return explicitClose || removed || replaced || handedOff || roleClose;
}

function collectTargetOperationEnds(text: string) {
  const events: PersistentEvent[] = [];
  const seen = new Set<string>();
  for (const segment of textSegments(text)) {
    for (const kind of ["surveillance", "protection", "pursuit", "assignment"] as const) {
      const term = OPERATION_TERM[kind];
      const patterns = [
        new RegExp(
          `([가-힣A-Za-z][가-힣A-Za-z0-9·_-]{1,19})\\s*에\\s*대한\\s*${term}\\s*(?:은|는|이|가|을|를)?[^.!?]{0,35}${OPERATION_END}`,
          "gu"
        ),
        new RegExp(
          `([가-힣A-Za-z][가-힣A-Za-z0-9·_-]{1,19})(?:의|을|를)\\s*${term}\\s*(?:은|는|이|가|을|를)?[^.!?]{0,35}${OPERATION_END}`,
          "gu"
        ),
      ];
      for (const pattern of patterns) {
        for (const match of segment.text.matchAll(pattern)) {
          if (hasNegatedOperationEnd(segment.text)) continue;
          const target = String(match[1] || "").trim();
          if (!target) continue;
          const key = `${kind}:${segment.index}:${target}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const matchedText = String(match[0] || "");
          const closeAt = matchedText.search(new RegExp(OPERATION_END, "u"));
          events.push({
            kind,
            action: "end",
            index: segment.index + Number(match.index || 0) + Math.max(0, closeAt),
            detail: compactDetail(segment.text),
            target,
          });
        }
      }
    }
  }
  return events;
}

function collectOperationRoleEnds(text: string) {
  const events: PersistentEvent[] = [];
  const roleByKind: Array<{
    kind: "surveillance" | "protection" | "pursuit";
    role: string;
  }> = [
    { kind: "surveillance", role: "(?:감시|잠복)\\s*(?:팀|조|반)" },
    { kind: "protection", role: "(?:경호|보호)\\s*(?:팀|조|반)" },
    { kind: "pursuit", role: "(?:추적|수색|추격)\\s*(?:팀|조|반)" },
  ];
  for (const segment of textSegments(text)) {
    for (const { kind, role } of roleByKind) {
      const match = new RegExp(
        `${role}\\s*(?:은|는|이|가|도|[:：-])?[^.!?]{0,45}${OPERATION_END}`,
        "u"
      ).exec(segment.text);
      if (!match) continue;
      const matchedText = String(match[0] || "");
      if (hasNegatedOperationEnd(segment.text)) continue;
      const closeAt = matchedText.search(new RegExp(OPERATION_END, "u"));
      const index = segment.index + Number(match.index || 0) + Math.max(0, closeAt);
      events.push({
        kind,
        action: "end",
        index,
        detail: compactDetail(segment.text),
      });
      // A generic assignment shadow may have been created alongside the more
      // specific operation. A whole team withdrawal closes that shadow too.
      events.push({
        kind: "assignment",
        action: "end",
        index,
        detail: compactDetail(segment.text),
      });
    }
  }
  return events;
}

function normalizedContinuityText(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s'"“”‘’.,!?。！？,，;；:：(){}\[\]<>·_-]+/gu, "")
    .toLowerCase();
}

function stateMatchesOperationTarget(state: ContinuityState | undefined, target: string) {
  if (!state || !target.trim()) return false;
  const needle = normalizedContinuityText(target);
  if (needle.length < 2) return false;
  return normalizedContinuityText(`${state.title} ${state.detail || ""}`).includes(needle);
}

function hasAssignmentStart(segment: string, rawName: string) {
  const name = escapeRegExp(rawName);
  const subject = `${name}(?:\\s*(?:${AGENT_ROLE}))?\\s*(?:은|는|이|가|도|[:：-])`;
  if (!new RegExp(subject, "u").test(segment)) return false;
  if (isDelegatingOperation(segment, rawName, OPERATION_TERM.assignment)) return false;
  return new RegExp(
    `${subject}[^.!?]{0,150}(?:담당(?:하게\\s*됐|하기로|한다|하고\\s*있|\\s*중|을\\s*맡)|전담(?:한다|하게\\s*됐|\\s*중)|(?:임무|역할|운전|당번)(?:을|를)?\\s*(?:맡|담당)|배치(?:됐|되었|됨|되어)|파견(?:됐|되었|됨)|임명(?:됐|되었|됨)|근무\\s*중|(?:지시|명령)(?:를|을)\\s*받)`,
    "u"
  ).test(segment);
}

function hasDetainedStart(segment: string, rawName: string) {
  const name = escapeRegExp(rawName);
  return new RegExp(
    `(?:${name}(?:은|는|이|가|도)?[^.!?]{0,70}(?:체포되|구속되|구금되|수감되|감금되|억류되|구속\\s*중|구금\\s*중|수감\\s*중)` +
      `|${name}(?:을|를)[^.!?]{0,60}(?:체포했|구속했|구금했|수감했|감금했|억류했)` +
      `|(?:체포된|구속된|구금된|수감된|감금된|억류된)\\s*${name})`,
    "u"
  ).test(segment);
}

function hasDetainedEnd(segment: string, rawName: string) {
  const name = escapeRegExp(rawName);
  return new RegExp(
    `(?:${name}(?:은|는|이|가|도)?[^.!?]{0,80}(?:석방되|출소했|풀려났|보석으로\\s*나왔|구속\\s*(?:취소|해제)|구금\\s*(?:종료|해제)|감금에서\\s*탈출)` +
      `|${name}(?:을|를)[^.!?]{0,55}(?:석방했|풀어줬|풀어주|구속을\\s*취소|구금을\\s*해제))`,
    "u"
  ).test(segment);
}

function hasHospitalizedStart(segment: string, rawName: string) {
  const name = escapeRegExp(rawName);
  return new RegExp(
    `(?:${name}(?:은|는|이|가|도)?[^.!?]{0,85}(?:입원(?:했|함|하게\\s*됐|\\s*중)|병원에서\\s*(?:계속\\s*)?치료\\s*중|중환자실|병실에서\\s*치료)` +
      `|${name}(?:을|를)[^.!?]{0,55}입원시켰|입원한\\s*${name})`,
    "u"
  ).test(segment);
}

function hasHospitalizedEnd(segment: string, rawName: string) {
  const name = escapeRegExp(rawName);
  return new RegExp(
    `(?:${name}(?:은|는|이|가|도)?[^.!?]{0,80}(?:퇴원(?:했|함|하게\\s*됐)|치료를\\s*마치고\\s*(?:귀가|퇴원)|완치(?:되어|돼)\\s*(?:귀가|퇴원)|병원을\\s*나섰)` +
      `|${name}(?:을|를)[^.!?]{0,55}퇴원시켰)`,
    "u"
  ).test(segment);
}

function collectPersistentEvents(text: string, identity: ContinuityIdentity) {
  const events: PersistentEvent[] = [];
  const names = identityNames(identity);
  for (const segment of textSegments(text)) {
    if (!names.some((name) => segment.text.includes(name))) continue;
    const historical = /(?:과거|한때|예전|이전에는|당시)(?:\s|[,，:：]|$)/u.test(segment.text)
      && !/(?:현재|지금|여전히|계속|상주|전담|진행\s*중)/u.test(segment.text);
    for (const name of names) {
      if (!segment.text.includes(name)) continue;
      const localText = localContextForName(segment.text, name, names);
      for (const kind of ["surveillance", "protection", "pursuit"] as const) {
        if (!historical && hasPersistentOperationStart(localText, name, kind)) {
          events.push({ kind, action: "start", index: segment.index, detail: compactDetail(segment.text) });
        }
        if (hasPersistentOperationEnd(localText, name, kind)) {
          events.push({ kind, action: "end", index: segment.index + localText.search(new RegExp(OPERATION_END, "u")), detail: compactDetail(segment.text) });
        }
      }
      const specializedStart = events.some(
        (event) => event.index === segment.index && event.action === "start" && event.kind !== "assignment"
      );
      if (!historical && !specializedStart && hasAssignmentStart(localText, name)) {
        events.push({ kind: "assignment", action: "start", index: segment.index, detail: compactDetail(segment.text) });
      }
      if (hasPersistentOperationEnd(localText, name, "assignment")) {
        events.push({ kind: "assignment", action: "end", index: segment.index, detail: compactDetail(segment.text) });
      }
      if (!historical && hasDetainedStart(localText, name)) {
        events.push({ kind: "detained", action: "start", index: segment.index, detail: compactDetail(segment.text) });
      }
      if (hasDetainedEnd(localText, name)) {
        events.push({ kind: "detained", action: "end", index: segment.index, detail: compactDetail(segment.text) });
      }
      if (!historical && hasHospitalizedStart(localText, name)) {
        events.push({ kind: "hospitalized", action: "start", index: segment.index, detail: compactDetail(segment.text) });
      }
      if (hasHospitalizedEnd(localText, name)) {
        events.push({ kind: "hospitalized", action: "end", index: segment.index, detail: compactDetail(segment.text) });
      }
    }
  }
  return events.sort((a, b) => a.index - b.index || (a.action === "end" ? -1 : 1));
}

function collectMatches(text: string, names: string[]) {
  const matches: StateMatch[] = [];
  const add = (kind: ContinuityStateKind, priority: number, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      matches.push({ kind, priority, index: Number(match.index || 0) });
    }
  };

  for (const rawName of names) {
    const name = escapeRegExp(rawName);
    const subject = `${name}(?:은|는|이|가|도|마저)?`;

    // Corrections and confirmed returns override an earlier death report.
    add(
      "alive",
      4,
      new RegExp(
        `${subject}\\s*(?:실제로\\s*)?(?:생존(?:했|함|해|이\\s*확인)|살아\\s*있|살아서\\s*돌아|구조되|구출되|부활|되살아|죽지\\s*않)`,
        "gu"
      )
    );
    add("alive", 4, new RegExp(`(?:생존한|살아\\s*있는|부활한|되살아난|구조된|구출된)\\s*${name}`, "gu"));
    add(
      "alive",
      5,
      new RegExp(`${name}(?:의)?\\s*(?:사망|사살|죽음)[^.!?\\n]{0,28}(?:오보|거짓|조작|허위)`, "gu")
    );

    // Reports are kept distinct from confirmed deaths, but still block a casual
    // physical reappearance until a later section confirms survival.
    add(
      "reported_deceased",
      3,
      new RegExp(`${name}의\\s*(?:사망|사살)\\s*(?:보도|발표|소식|설|주장)`, "gu")
    );
    add(
      "reported_deceased",
      3,
      new RegExp(`${subject}\\s*(?:사망했|사살됐|사살되었|죽었)다는\\s*(?:보도|발표|소식|주장)`, "gu")
    );

    // Confirmed terminal states require the character name to be grammatically
    // attached to the predicate. This avoids errors such as treating
    // "윈터의 남성 사살" as "윈터 사망".
    add(
      "deceased",
      2,
      new RegExp(
        `${subject}\\s*(?:(?:결국|끝내|즉시|현장에서|그\\s*자리에서|병원에서)\\s*)?(?:사망(?:했|함|했다|하였다|한\\s*것으로\\s*확인)|사살(?:됐|되었|됨|당했|당함)|숨졌|죽었|목숨을\\s*잃|시신으로\\s*발견|사체로\\s*발견|서거(?:했|함|했다)|순직(?:했|함|했다))`,
        "gu"
      )
    );
    add("deceased", 2, new RegExp(`${name}\\s*(?:사망|사살|죽음)(?=\\s|$|[,.!?])`, "gu"));
    add("deceased", 2, new RegExp(`${name}의\\s*(?:사망|죽음|시신|사체)(?!\\s*(?:보도|발표|소식|설|주장))`, "gu"));
    add("deceased", 2, new RegExp(`(?:사망한|숨진|죽은|사살된|시신이\\s*된)\\s*${name}`, "gu"));

    add(
      "missing",
      1,
      new RegExp(`${subject}\\s*(?:실종(?:됐|되었|됨|당했|상태)|행방불명|행방이\\s*묘연|종적을\\s*감췄)`, "gu")
    );
    add("missing", 1, new RegExp(`(?:실종된|행방불명된)\\s*${name}`, "gu"));
  }

  matches.sort((a, b) => a.index - b.index || a.priority - b.priority);
  return matches;
}

function latestStateForIdentity(
  historySummary: string,
  identity: ContinuityIdentity,
  parsedSections?: StoredSummarySection[]
): ContinuityState | null {
  const names = identityNames(identity);
  if (!names.length) return null;

  let latest: ContinuityState | null = null;
  const sections = parsedSections || extractSummarySections(historySummary).sort(
    (a, b) => a.startTurn - b.startTurn || a.endTurn - b.endTurn
  );

  for (const section of sections) {
    const events = collectMatches(`${section.title}\n${section.body}`, names);
    const event = events[events.length - 1];
    if (!event) continue;
    latest = {
      name: identity.name.trim(),
      kind: event.kind,
      startTurn: section.startTurn,
      endTurn: section.endTurn,
      title: section.title.trim(),
    };
  }

  // A manually maintained current status is more authoritative than an old summary.
  const statusEvents = collectMatches(`${identity.name} ${identity.status || ""}`, [identity.name]);
  const explicitStatus = statusEvents[statusEvents.length - 1];
  if (explicitStatus) {
    latest = {
      name: identity.name.trim(),
      kind: explicitStatus.kind,
      startTurn: latest?.startTurn || 0,
      endTurn: latest?.endTurn || 0,
      title: "캐릭터 현재 상태",
    };
  }
  return latest;
}

function persistentStatesForIdentity(
  historySummary: string,
  identity: ContinuityIdentity,
  userText: string,
  parsedSections?: StoredSummarySection[]
) {
  const active = new Map<PersistentContinuityStateKind, ContinuityState>();
  const historyKinds = new Set<PersistentContinuityStateKind>();
  const applyEvents = (
    events: PersistentEvent[],
    source: { startTurn: number; endTurn: number; title: string }
  ) => {
    for (const event of events) {
      if (event.action === "end") {
        const current = active.get(event.kind);
        if (!event.target || stateMatchesOperationTarget(current, event.target)) {
          active.delete(event.kind);
        }
        continue;
      }
      const prior = active.get(event.kind);
      active.set(event.kind, {
        name: identity.name.trim(),
        kind: event.kind,
        startTurn: prior?.startTurn || source.startTurn,
        endTurn: prior?.endTurn || source.endTurn,
        lastConfirmedTurn: Math.max(prior?.lastConfirmedTurn || 0, source.endTurn),
        title: prior?.title || source.title,
        detail: event.detail || prior?.detail,
      });
    }
  };

  const sections = parsedSections || extractSummarySections(historySummary).sort(
    (a, b) => a.startTurn - b.startTurn || a.endTurn - b.endTurn
  );
  for (const section of sections) {
    const sectionText = `${section.title}\n${section.body}`;
    const events = [
      ...collectPersistentEvents(sectionText, identity),
      ...collectTargetOperationEnds(sectionText),
      ...collectOperationRoleEnds(sectionText),
    ].sort((a, b) => a.index - b.index || (a.action === "end" ? -1 : 1));
    for (const event of events) historyKinds.add(event.kind);
    applyEvents(events, {
      startTurn: section.startTurn,
      endTurn: section.endTurn,
      title: section.title.trim(),
    });
  }

  // Current roster fields are authoritative only when they use an ongoing-state
  // marker. Historical prose is rejected inside collectPersistentEvents.
  for (const [label, value, authoritative] of [
    ["캐릭터 현재 상태", identity.status, true],
    ["캐릭터 프로필", identity.profile, false],
    ["캐릭터 역할", identity.role, false],
    ["캐릭터 관계 메모", identity.relationshipNote, false],
    ["캐릭터 감정 메모", identity.emotionNote, false],
  ] as const) {
    const text = String(value || "").trim();
    if (!text) continue;
    const fallbackEvents = collectPersistentEvents(`${identity.name}은 ${text}`, identity)
      .filter((event) => authoritative || !historyKinds.has(event.kind));
    applyEvents(fallbackEvents, {
      startTurn: 0,
      endTurn: 0,
      title: label,
    });
  }

  // The newest user turn may explicitly start, hand off, cancel, or finish a
  // state before that turn has entered the stored archive.
  applyEvents([
    ...collectPersistentEvents(userText, identity),
    ...collectTargetOperationEnds(userText),
    ...collectOperationRoleEnds(userText),
  ].sort((a, b) => a.index - b.index || (a.action === "end" ? -1 : 1)), {
    startTurn: 0,
    endTurn: 0,
    title: "현재 사용자 입력",
  });
  return [...active.values()];
}

function anonymousRoleActors(segment: string, identities: ContinuityIdentity[]) {
  const actors: string[] = [];
  const pattern = new RegExp(`(?:사복\\s*)?(?:형사|경찰|수사관|요원|경호원|경비원|대원|간호사|의사|직원)|(?:감시|경호|수사|순찰|전담)\\s*(?:팀|조|반)|담당자`, "gu");
  for (const match of segment.matchAll(pattern)) {
    const actor = compactDetail(String(match[0] || ""), 40);
    const index = Number(match.index || 0);
    const suffix = segment.slice(index + String(match[0] || "").length, index + String(match[0] || "").length + 3);
    if (!/^(?:은|는|이|가|도|[:：-])/u.test(suffix)) continue;
    const immediatelyNamed = identities.some((identity) =>
      identityNames(identity).some((name) =>
        new RegExp(`${escapeRegExp(name)}\\s*${escapeRegExp(actor)}(?:은|는|이|가|도)`, "u").test(segment)
      )
    );
    if (!immediatelyNamed) actors.push(actor);
  }
  return actors;
}

const OPERATION_TRANSFER = /(?:교대|이어받|인계받|인수|대신|교체|넘겨받)/u;

function detailsShareKnownIdentity(
  left: string,
  right: string,
  identities: ContinuityIdentity[]
) {
  return identities.some((identity) =>
    identityNames(identity).some((name) => left.includes(name) && right.includes(name))
  );
}

function retireTransferredAnonymousStates(
  active: Map<string, ContinuityState>,
  segment: string,
  identities: ContinuityIdentity[]
) {
  if (!OPERATION_TRANSFER.test(segment)) return;

  for (const identity of identities) {
    const names = identityNames(identity);
    if (!names.some((name) => segment.includes(name))) continue;
    const starts = collectPersistentEvents(segment, identity)
      .filter((event) => event.action === "start");
    for (const event of starts) {
      const candidates = [...active.entries()]
        .filter(([, state]) => state.kind === event.kind);
      if (!candidates.length) continue;
      const sameSubject = candidates.filter(([, state]) =>
        detailsShareKnownIdentity(String(state.detail || ""), event.detail, identities)
      );
      // A handoff retires the older role-only shadow. Prefer a shared named
      // target/location; if only one anonymous operation of this kind exists,
      // the explicit transfer itself is sufficient evidence.
      const retired = sameSubject.length > 0
        ? sameSubject
        : candidates.length === 1
          ? candidates
          : [];
      for (const [key] of retired) active.delete(key);
    }
  }
}

function anonymousPersistentStates(
  historySummary: string,
  identities: ContinuityIdentity[],
  userText: string,
  parsedSections?: StoredSummarySection[]
) {
  const active = new Map<string, ContinuityState>();
  const sources = [
    ...(parsedSections || extractSummarySections(historySummary)
      .sort((a, b) => a.startTurn - b.startTurn || a.endTurn - b.endTurn))
      .map((section) => ({
        text: `${section.title}\n${section.body}`,
        startTurn: section.startTurn,
        endTurn: section.endTurn,
        title: section.title.trim(),
      })),
    ...(String(userText || "").trim()
      ? [{ text: userText, startTurn: 0, endTurn: 0, title: "현재 사용자 입력" }]
      : []),
  ];

  for (const source of sources) {
    for (const segment of textSegments(source.text)) {
      retireTransferredAnonymousStates(active, segment.text, identities);
      for (const event of collectTargetOperationEnds(segment.text)) {
        for (const [key, state] of active) {
          if (
            state.kind === event.kind
            && event.target
            && stateMatchesOperationTarget(state, event.target)
          ) active.delete(key);
        }
      }
      for (const actor of anonymousRoleActors(segment.text, identities)) {
        for (const kind of ["surveillance", "protection", "pursuit"] as const) {
          const key = `${kind}:${actor}`;
          if (hasPersistentOperationEnd(segment.text, actor, kind)) active.delete(key);
          if (hasPersistentOperationStart(segment.text, actor, kind)) {
            const prior = active.get(key);
            active.set(key, {
              name: actor,
              kind,
              startTurn: prior?.startTurn || source.startTurn,
              endTurn: prior?.endTurn || source.endTurn,
              lastConfirmedTurn: Math.max(prior?.lastConfirmedTurn || 0, source.endTurn),
              title: prior?.title || source.title,
              detail: compactDetail(segment.text),
            });
          }
        }
        const key = `assignment:${actor}`;
        if (hasPersistentOperationEnd(segment.text, actor, "assignment")) active.delete(key);
        if (hasAssignmentStart(segment.text, actor)) {
          const prior = active.get(key);
          active.set(key, {
            name: actor,
            kind: "assignment",
            startTurn: prior?.startTurn || source.startTurn,
            endTurn: prior?.endTurn || source.endTurn,
            lastConfirmedTurn: Math.max(prior?.lastConfirmedTurn || 0, source.endTurn),
            title: prior?.title || source.title,
            detail: compactDetail(segment.text),
          });
        }
      }
    }
  }
  return [...active.values()];
}

function hasExplicitSurvivalRetcon(userText: string, identity: ContinuityIdentity) {
  const text = String(userText || "").replace(/\s+/g, " ");
  if (!identityNames(identity).some((name) => text.includes(name))) return false;
  const correction = /(?:설정|정정|수정|취소|리트콘|오보|사실|알고\s*보니|죽은\s*게\s*아니|죽은\s*것이\s*아니)/u;
  const survival = /(?:안\s*죽|죽지\s*않|생존|살아\s*있|부활|되살아)/u;
  return correction.test(text) && survival.test(text);
}

export function deriveContinuityStates(params: {
  historySummary: string;
  identities: ContinuityIdentity[];
  userText?: string;
}) {
  const states: ContinuityState[] = [];
  const historySummary = String(params.historySummary || "");
  const userText = String(params.userText || "");
  const parsedSections = extractSummarySections(historySummary).sort(
    (a, b) => a.startTurn - b.startTurn || a.endTurn - b.endTurn
  );
  for (const identity of params.identities) {
    if (!String(identity?.name || "").trim()) continue;
    const terminalState = latestStateForIdentity(
      historySummary,
      identity,
      parsedSections
    );
    const retconned = hasExplicitSurvivalRetcon(userText, identity);
    if (terminalState && terminalState.kind !== "alive" && !retconned) states.push(terminalState);

    const persistent = persistentStatesForIdentity(
      historySummary,
      identity,
      userText,
      parsedSections
    );
    for (const state of persistent) {
      // A later unresolved death/missing state makes an earlier duty or location
      // impossible; an explicit survival correction restores normal processing.
      if (
        terminalState
        && terminalState.kind !== "alive"
        && !retconned
        && terminalState.endTurn >= (state.lastConfirmedTurn || state.endTurn)
      ) continue;
      states.push(state);
    }
  }

  const anonymous = anonymousPersistentStates(
    historySummary,
    params.identities,
    userText,
    parsedSections
  );
  for (const state of anonymous) {
    const replacedByNamedActor = states.some(
      (candidate) =>
        candidate.kind === state.kind
        && candidate.name !== state.name
        && /(?:교대|이어받|인계받)/u.test(String(candidate.detail || ""))
        && (candidate.lastConfirmedTurn || candidate.endTurn) >= (state.lastConfirmedTurn || state.endTurn)
    );
    if (!replacedByNamedActor) states.push(state);
  }

  return states.sort(
    (a, b) =>
      (b.lastConfirmedTurn || b.endTurn) - (a.lastConfirmedTurn || a.endTurn)
      || a.name.localeCompare(b.name, "ko")
      || a.kind.localeCompare(b.kind)
  );
}

export function buildContinuityLedgerBlock(params: {
  historySummary: string;
  identities: ContinuityIdentity[];
  userText?: string;
  focusNames?: string[];
}) {
  const states = deriveContinuityStates(params);
  if (!states.length) {
    return { block: "", states, promptStates: [] as ContinuityState[] };
  }

  const rowForState = (state: ContinuityState) => {
    const range = state.endTurn > 0
      ? state.startTurn === state.endTurn
        ? `${state.endTurn}턴`
        : `${state.startTurn}-${state.endTurn}턴`
      : "현재 상태표";
    const detail = state.detail ? ` | 내용: ${state.detail}` : "";
    return `- ${state.name}: ${STATE_LABEL[state.kind]} | 시작 근거 ${range} '${state.title}'${detail}`;
  };

  const focusNames = (params.focusNames || [])
    .map((value) => String(value || "").trim().toLocaleLowerCase("ko-KR"))
    .filter((value) => value.length >= 2);
  const currentText = String(params.userText || "").toLocaleLowerCase("ko-KR");
  const relevanceScore = (state: ContinuityState) => {
    const name = state.name.toLocaleLowerCase("ko-KR");
    const evidence = `${state.title} ${state.detail || ""}`.toLocaleLowerCase("ko-KR");
    let score = currentText.includes(name) ? 1000 : 0;
    for (const focusName of focusNames) {
      if (name === focusName) score += 900;
      if (evidence.includes(focusName)) score += 800;
    }
    return score;
  };
  const rankedStates = [...states].sort(
    (a, b) =>
      relevanceScore(b) - relevanceScore(a) ||
      (b.lastConfirmedTurn || b.endTurn) - (a.lastConfirmedTurn || a.endTurn)
  );
  const promptStates: ContinuityState[] = [];
  const rows: string[] = [];
  let detailedChars = 0;
  for (const state of rankedStates) {
    const row = rowForState(state);
    if (
      promptStates.length >= 40 ||
      (promptStates.length > 0 && detailedChars + row.length > 6000)
    ) continue;
    promptStates.push(state);
    rows.push(row);
    detailedChars += row.length;
  }
  const promptKeys = new Set(
    promptStates.map(
      (state) => `${state.kind}\u0000${state.name}\u0000${state.startTurn}`
    )
  );
  const compactGroups = new Map<ContinuityStateKind, string[]>();
  for (const state of states) {
    const key = `${state.kind}\u0000${state.name}\u0000${state.startTurn}`;
    if (promptKeys.has(key)) continue;
    const names = compactGroups.get(state.kind) || [];
    if (!names.includes(state.name)) names.push(state.name);
    compactGroups.set(state.kind, names);
  }
  const compactRows: string[] = [];
  let compactChars = 0;
  let omittedStateCount = 0;
  for (const [kind, names] of compactGroups) {
    const row = `- [BACKGROUND ACTIVE] ${STATE_LABEL[kind]}: ${names.join(", ")}`;
    if (compactChars + row.length <= 3000) {
      compactRows.push(row);
      compactChars += row.length;
    } else {
      omittedStateCount += names.length;
    }
  }
  if (omittedStateCount > 0) {
    compactRows.push(
      `- [BACKGROUND ACTIVE] ${omittedStateCount} unrelated states omitted from this turn's detail budget.`
    );
  }

  return {
    states,
    promptStates,
    block: [
      "# (2-A) 인물 연속성 장부(최우선 정사)",
      "- 아래 상태는 시간순 장기기억에서 계산한 현재 정사다. 과거 등장 기록이나 일반적인 최신 장면 지시보다 우선한다.",
      "- 사망 확정 또는 사망 처리된 인물은 이후 생존 확인이나 사용자의 명시적 설정 정정이 없는 한 살아서 말하거나 행동하거나 현장에 나타날 수 없다.",
      "- 최신 입력이 해당 인물을 다른 인물과 함께 단순 나열해도 즉석 부활로 해석하지 않는다. 부재, 회상, 보도, 사진, 기록처럼 기존 정사를 지키며 장면을 자연스럽게 이어간다.",
      "- 실종 인물도 귀환 근거 없이 현장에 직접 등장시키지 않는다.",
      "- 감시·잠복·경호·보호·추적·수색·구금·입원·담당·배치 상태는 명시적인 해제, 중단, 종료, 취소, 철수, 교대, 석방, 퇴원 기록이 나온 때에만 끝난다. 단순한 시간 경과, 최근 장면에서의 미언급, 장소 이동, 감시를 속인 행동만으로 종료하지 않는다.",
      "- 진행 중인 상태의 담당자와 대상, 배치 장소를 장면에 반영한다. 사용자가 담당자를 바꾸지 않았다면 일반 순찰자나 새 인물을 임의로 대신 세우지 않는다.",
      "- 이 충돌을 사용자에게 시스템 설명으로 노출하지 말고 서사 안에서 자연스럽게 처리한다.",
      ...rows,
      ...(compactRows.length
        ? [
            "- [BACKGROUND ACTIVE] rows are reference-only. Do not place those actors in the current scene merely because their names are listed.",
            ...compactRows,
          ]
        : []),
    ].join("\n"),
  };
}
