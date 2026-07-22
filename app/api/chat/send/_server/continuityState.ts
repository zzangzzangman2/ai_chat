import { extractSummarySections } from "./summaryStored";

export type ContinuityIdentity = {
  name: string;
  aliases?: string;
  status?: string;
};

export type ContinuityStateKind = "deceased" | "reported_deceased" | "missing" | "alive";

export type ContinuityState = {
  name: string;
  kind: ContinuityStateKind;
  startTurn: number;
  endTurn: number;
  title: string;
};

type StateMatch = { kind: ContinuityStateKind; index: number; priority: number };

const STATE_LABEL: Record<ContinuityStateKind, string> = {
  deceased: "사망 확정",
  reported_deceased: "사망 처리됨(이후 생존 확인 없음)",
  missing: "실종/행방불명",
  alive: "생존 확인",
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

function latestStateForIdentity(historySummary: string, identity: ContinuityIdentity): ContinuityState | null {
  const names = identityNames(identity);
  if (!names.length) return null;

  let latest: ContinuityState | null = null;
  const sections = extractSummarySections(historySummary).sort(
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
  for (const identity of params.identities) {
    if (!String(identity?.name || "").trim()) continue;
    const state = latestStateForIdentity(String(params.historySummary || ""), identity);
    if (!state || state.kind === "alive") continue;
    if (hasExplicitSurvivalRetcon(String(params.userText || ""), identity)) continue;
    states.push(state);
  }
  return states.sort((a, b) => b.endTurn - a.endTurn || a.name.localeCompare(b.name, "ko"));
}

export function buildContinuityLedgerBlock(params: {
  historySummary: string;
  identities: ContinuityIdentity[];
  userText?: string;
}) {
  const states = deriveContinuityStates(params);
  if (!states.length) return { block: "", states };

  const rows = states.slice(0, 20).map((state) => {
    const range = state.endTurn > 0
      ? state.startTurn === state.endTurn
        ? `${state.endTurn}턴`
        : `${state.startTurn}-${state.endTurn}턴`
      : "현재 상태표";
    return `- ${state.name}: ${STATE_LABEL[state.kind]} | 근거 ${range} '${state.title}'`;
  });

  return {
    states,
    block: [
      "# (2-A) 인물 연속성 장부(최우선 정사)",
      "- 아래 상태는 시간순 장기기억에서 계산한 현재 정사다. 과거 등장 기록이나 일반적인 최신 장면 지시보다 우선한다.",
      "- 사망 확정 또는 사망 처리된 인물은 이후 생존 확인이나 사용자의 명시적 설정 정정이 없는 한 살아서 말하거나 행동하거나 현장에 나타날 수 없다.",
      "- 최신 입력이 해당 인물을 다른 인물과 함께 단순 나열해도 즉석 부활로 해석하지 않는다. 부재, 회상, 보도, 사진, 기록처럼 기존 정사를 지키며 장면을 자연스럽게 이어간다.",
      "- 실종 인물도 귀환 근거 없이 현장에 직접 등장시키지 않는다.",
      "- 이 충돌을 사용자에게 시스템 설명으로 노출하지 말고 서사 안에서 자연스럽게 처리한다.",
      ...rows,
    ].join("\n"),
  };
}
