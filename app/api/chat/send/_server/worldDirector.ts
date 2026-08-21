type WorldDirectorMessage = {
  role?: unknown;
  content?: unknown;
};

type WorldDirectorInput = {
  messages: WorldDirectorMessage[];
  currentUserText?: string;
  authorConstraintText?: string;
  registeredNames?: string[];
  chatId?: string;
  userTurnCount?: number;
  focusedConversation?: boolean;
};

export type WorldActivityAssessment = {
  assistantTurnsReviewed: number;
  sameLocation: boolean;
  activeRegisteredNames: string[];
  newlyActiveRegisteredNames: string[];
  lexicalSimilarity: number;
  stagnationScore: number;
  scheduled: boolean;
  sceneLocked: boolean;
  explicitRequest: boolean;
  focusedConversation: boolean;
  shouldActivate: boolean;
};

const TOKEN_STOPWORDS = new Set([
  "그리고",
  "하지만",
  "그러나",
  "그대로",
  "때문에",
  "순간",
  "사람",
  "자신",
  "정도로",
  "이미",
  "다시",
  "계속",
  "현재",
  "장면",
  "사용자",
  "어시스턴트",
]);

const EXPLICIT_WORLD_REQUEST_RE =
  /(?:새(?:로운)?\s*(?:인물|캐릭터|사람|NPC)|처음\s*보는\s*사람).{0,24}(?:등장|추가|투입|나오|만나)|(?:누군가|새\s*손님|새\s*학생|새\s*동료).{0,16}(?:오게|찾아오|등장)/i;
const SCENE_LOCK_RE =
  /(?:새(?:로운)?\s*(?:인물|캐릭터|사람|NPC)|제3자).{0,28}(?:등장\s*금지|추가\s*금지|등장하지|추가하지|나오지|오지\s*마)|(?:아무도|누구도|제3자는?).{0,20}(?:오지\s*마|들어오지\s*마|등장하지\s*마|방해하지\s*마)|(?:단둘이|둘만의|혼자만의).{0,20}(?:유지|계속)|(?:외부와|바깥과).{0,12}(?:완전히\s*)?차단/i;

function stripFencedBlocks(raw: unknown) {
  return String(raw || "").replace(/```[\s\S]*?```/g, " ");
}

function normalizedNameList(rawNames: string[]) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawNames || []) {
    const name = String(raw || "").trim();
    if (!name || name.length > 40 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.slice(0, 40);
}

function extractLocation(raw: unknown) {
  const source = String(raw || "");
  const match = source.match(/(?:^|\n)\s*(?:장소|위치)\s*:\s*([^\n|`]{1,120})/im);
  return String(match?.[1] || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenSet(raw: unknown) {
  const source = stripFencedBlocks(raw).toLowerCase();
  const tokens = source.match(/[가-힣]{2,}|[a-z0-9]{3,}/g) || [];
  const out = new Set<string>();
  for (const token of tokens) {
    if (TOKEN_STOPWORDS.has(token)) continue;
    out.add(token);
    if (out.size >= 180) break;
  }
  return out;
}

function jaccard(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function stableHash(raw: string) {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function scheduledDirectorTurn(chatId: string, userTurnCount: number) {
  const turn = Math.max(0, Math.floor(userTurnCount || 0));
  if (turn < 3) return false;
  const cycleLength = 5;
  const cycleIndex = Math.floor((turn - 1) / cycleLength);
  const position = ((turn - 1) % cycleLength) + 1;
  const triggerPosition = 3 + (stableHash(`${chatId}:${cycleIndex}`) % 3);
  return position === triggerPosition;
}

export function assessWorldActivity(input: WorldDirectorInput): WorldActivityAssessment {
  const assistantTurns = (input.messages || [])
    .filter((message) => String(message?.role || "").toLowerCase() === "assistant")
    .slice(-6);
  const recentFour = assistantTurns.slice(-4);
  const cleanTexts = assistantTurns.map((message) => stripFencedBlocks(message?.content));
  const recentText = cleanTexts.slice(-4).join("\n");
  const registeredNames = normalizedNameList(input.registeredNames || []);
  const activeRegisteredNames = registeredNames.filter((name) => recentText.includes(name));
  const olderText = cleanTexts.slice(0, -2).join("\n");
  const newestText = cleanTexts.slice(-2).join("\n");
  const newlyActiveRegisteredNames = registeredNames.filter(
    (name) => newestText.includes(name) && !olderText.includes(name)
  );

  const locations = recentFour.map((message) => extractLocation(message?.content)).filter(Boolean);
  const sameLocation = locations.length >= 3 && new Set(locations).size === 1;

  const latestTokens = tokenSet(assistantTurns.at(-1)?.content);
  const comparisonTurns = assistantTurns.slice(-4, -1);
  const similarities = comparisonTurns.map((message) => jaccard(latestTokens, tokenSet(message?.content)));
  const lexicalSimilarity = similarities.length
    ? similarities.reduce((sum, value) => sum + value, 0) / similarities.length
    : 0;

  let stagnationScore = 0;
  if (sameLocation) stagnationScore += 2;
  if (activeRegisteredNames.length <= 2) stagnationScore += 2;
  else if (activeRegisteredNames.length <= 3) stagnationScore += 1;
  if (newlyActiveRegisteredNames.length === 0) stagnationScore += 1;
  if (lexicalSimilarity >= 0.24) stagnationScore += 2;
  else if (lexicalSimilarity >= 0.14) stagnationScore += 1;
  if (assistantTurns.length >= 6) stagnationScore += 1;

  const currentUserText = String(input.currentUserText || "")
    .replace(/\s+/g, " ")
    .trim();
  const authorConstraintText = String(input.authorConstraintText || "")
    .replace(/\s+/g, " ")
    .trim();
  const sceneLocked = SCENE_LOCK_RE.test(`${authorConstraintText}\n${currentUserText}`);
  const explicitRequest = EXPLICIT_WORLD_REQUEST_RE.test(currentUserText);
  const focusedConversation = Boolean(input.focusedConversation);
  const scheduled = scheduledDirectorTurn(
    String(input.chatId || "chat"),
    Math.max(0, Math.floor(input.userTurnCount || 0))
  );
  const stagnant = assistantTurns.length >= 4 && stagnationScore >= 3;
  const shouldActivate =
    !sceneLocked && (explicitRequest || (!focusedConversation && scheduled && stagnant));

  return {
    assistantTurnsReviewed: assistantTurns.length,
    sameLocation,
    activeRegisteredNames,
    newlyActiveRegisteredNames,
    lexicalSimilarity: Number(lexicalSimilarity.toFixed(3)),
    stagnationScore,
    scheduled,
    sceneLocked,
    explicitRequest,
    focusedConversation,
    shouldActivate,
  };
}

export function buildWorldDirectorBlock(input: WorldDirectorInput) {
  const assessment = assessWorldActivity(input);
  if (!assessment.shouldActivate) return "";

  const registeredNames = normalizedNameList(input.registeredNames || []);
  const activeSet = new Set(assessment.activeRegisteredNames);
  const inactiveCandidates = registeredNames.filter((name) => !activeSet.has(name)).slice(0, 8);
  const triggerReason = assessment.explicitRequest
    ? "사용자가 현재 입력에서 새로운 인물 또는 세계 개입을 직접 요청했다."
    : "최근 장면이 같은 장소·소수 인물·유사 반응에 머물러 세계 활성화 시점이 되었다.";

  return [
    "# [CURRENT WORLD ACTIVITY DIRECTIVE — 사이트 공통/현재 턴]",
    `- 발동 이유: ${triggerReason}`,
    "- 이번 답변에서는 현재 반응만 되풀이하지 말고, 서사를 전진시키는 외부 세계 변수 정확히 1개를 자연스럽게 도입한다.",
    "- 도입 우선순위: (1) 원작·시대·장소·관계상 개연성 있는 기존 인물의 재등장, (2) 목적을 가진 새로운 실명 NPC, (3) 직접 등장이 물리적으로 부자연스러우면 전화·초인종·무전·발소리·메시지·주변 사건 같은 외부 접촉.",
    inactiveCandidates.length
      ? `- 현재 장면 밖의 기존 등록 인물 후보(개연성이 있을 때만 선택): ${JSON.stringify(inactiveCandidates)}`
      : "- 재등장시킬 적절한 기존 인물이 없다면 세계관과 장소에 맞는 새 인물을 만든다.",
    "- 기존 작품 세계라면 임의의 오리지널 인물보다 해당 시점과 장소에 올 수 있는 원작 인물을 우선한다. 알맞은 원작 인물이 없을 때만 새 인물을 만든다.",
    "- 신규 NPC는 2~4글자 한글 실명, 장면에 온 구체적 이유, 현재 인물들과 다른 독립 목적·태도, 첫 행동 또는 직접 대사를 가진다. 이름은 첫 등장 답변에서 자연스럽게 2회 이상 명시해 후속 기억 등록이 가능하게 한다.",
    "- 신규·재등장 인물은 기존 인물의 감정과 대사를 복제하는 구경꾼이 아니라, 선택지·정보·갈등·도움 중 최소 하나를 실제로 바꾸어야 한다.",
    "- 한 답변에 새로 직접 등장하는 인물은 최대 1명이다. 현재 핵심 인물의 장면을 빼앗거나 여러 인물을 한꺼번에 쏟아내지 않는다.",
    "- 문이 잠겼거나 고립된 장소라면 순간이동시키지 않는다. 접근 과정과 물리적 원인을 먼저 보여주고, 직접 진입이 불가능하면 외부 접촉까지만 진행한다.",
    "- 사용자의 최신 행동을 대신 결정하지 않으며, OOC·제작자 설정·사용자가 명시한 독대/고립 조건과 충돌하면 그 조건을 우선한다.",
  ].join("\n");
}
