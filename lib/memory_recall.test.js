/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const Database = require("better-sqlite3");
const root = path.join(__dirname, "..");

function loader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const loaded = { exports: {} };
    cache.set(absolute, loaded);
    const output = ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id];
      if (id.startsWith("@/")) return load(`${id.slice(2)}.ts`);
      if (id.startsWith(".")) return load(path.resolve(path.dirname(absolute), `${id}.ts`));
      return require(id);
    };
    Function("require", "module", "exports", output)(localRequire, loaded, loaded.exports);
    return loaded.exports;
  }
  return load;
}

const load = loader();
const { findMentionedCharacterIds } = load("lib/character_mentions.ts");
const { findFocusedCharacterIds } = load("lib/relationship_memory.ts");
const { resolveActiveCharacterFocus } = load("lib/active_character_focus.ts");
const { buildMemoryRecallQuery, buildRecallEvidence, selectRecallSummary } = load("app/api/chat/send/_server/memoryRecall.ts");
const { selectHybridMemory, selectBroadHistoryMemory, rankMemoryRetrievalCandidates } = load("app/api/chat/send/_server/memorySelection.ts");
const identities = [
  { id: "seoyun", name: "김서윤", aliases: "" },
  { id: "minjun", name: "박민준", aliases: "" },
];
const query = (userText, previousUserTexts = []) => buildMemoryRecallQuery({ userText, previousUserTexts, identities });

test("unique Korean short names work consistently without mutating the roster", () => {
  for (const text of ["서윤이랑 있었던 일 기억해?", "서윤아, 책 받았어?", "서윤에게물어봐"]) {
    assert.deepEqual([...findMentionedCharacterIds(identities, text)], ["seoyun"]);
    assert.deepEqual([...findFocusedCharacterIds(identities, text)], ["seoyun"]);
    assert.deepEqual(resolveActiveCharacterFocus({ identities, currentUserText: text }).names, ["김서윤"]);
  }
  assert.equal(identities[0].aliases, "");
  assert.deepEqual([...findMentionedCharacterIds([{ id: "a", name: "남궁서윤" }], "서윤아")], ["a"]);
});

test("short-name inference rejects ambiguity, word fragments and one-letter aliases", () => {
  const ambiguous = [...identities, { id: "other", name: "이서윤" }];
  assert.equal(findMentionedCharacterIds(ambiguous, "서윤이랑 약속했잖아").size, 0);
  assert.deepEqual([...findMentionedCharacterIds(ambiguous, "김서윤이랑 약속했잖아")], ["seoyun"]);
  assert.equal(findMentionedCharacterIds(identities, "문서윤곽을 확인한다").size, 0);
  assert.equal(findMentionedCharacterIds([{ id: "a", name: "김서윤", aliases: '["나"]' }], "나왔다").size, 0);
  assert.equal(findMentionedCharacterIds(identities, "```상태\n김서윤: 5\n```").size, 0);
  const reserved = [...identities, { id: "other", name: "기록관", aliases: '["서윤"]' }];
  assert.deepEqual([...findMentionedCharacterIds(reserved, "서윤아")], ["other"]);
});

test("recall follow-ups retain the user-named subject without changing the scene speaker", () => {
  const first = "아까 서윤이랑 도서관에서 했던 약속 기억해?";
  const follow = query("그게 끝이야?", [first]);
  assert.equal(follow.requested, true);
  assert.deepEqual(follow.names, ["김서윤"]);
  assert.match(follow.searchText, /도서관/);
  assert.deepEqual(query("그리고 반납했지?", ["그게 끝이야?", first]).names, ["김서윤"]);
  assert.deepEqual(resolveActiveCharacterFocus({ identities, currentUserText: "그게 끝이야?", previousUserTexts: [first] }).names, []);
  assert.deepEqual(query("민준이랑 했던 약속은?", [first]).names, ["박민준"]);
  assert.equal(query("다음 날 다른 이야기로 장면 전환", [first]).requested, false);
  assert.equal(query("그게 끝이야?", ["다음 날 다른 이야기", first]).requested, false);
});

test("a small complete archive keeps the old event that falls outside the recent window", () => {
  const summary = Array.from({ length: 16 }, (_, i) =>
    `### 기록 ${i + 1} (${i * 3 + 1}-${i * 3 + 3}턴)\n${i === 10 ? "김서윤이 맡긴 책을 돌려받았다." : "마을에서 일상을 보냈다."}`
  ).join("\n\n");
  assert.match(selectRecallSummary(summary, query("서윤이랑 있었던 일 기억해?")), /31-33턴/);
  assert.equal(selectRecallSummary(summary, query("지금 문을 열자")), "");
});

test("colloquial past confirmations retrieve the action and preserve the recall subject", () => {
  const anchor = "아까 서윤이랑 도서관에서 했던 일 기억해?";
  for (const ending of ["했찌", "했지", "했죠", "했징", "했쥬", "했냐", "했었지"]) {
    const result = query(`반납${ending}?`, ["그게끝이야?", anchor]);
    assert.equal(result.requested, true, ending);
    assert.deepEqual(result.names, ["김서윤"], ending);
    assert.ok(result.searchText.split("\n").includes("반납"), ending);
  }
  assert.equal(query("합체했찌?").requested, true);
  assert.equal(query("그게끝이야?", ["반납했찌?", anchor]).requested, true);
  assert.equal(query("이제 다른 이야기로 장면 전환. 반납했찌?", [anchor]).requested, false);
  assert.deepEqual(query("반납했찌?", ["다음 날 다른 이야기", anchor]).names, []);
  assert.equal(query("로봇을 합체하자").requested, false);
  const archive = Array.from({ length: 40 }, (_, i) =>
    `### 기록 (${i * 3 + 1}-${i * 3 + 3}턴)\n${i === 2 ? "빌린 책을 도서관에 반납했다." : "마을의 일상적인 풍경을 기록했다. ".repeat(25)}`
  ).join("\n\n");
  assert.match(selectRecallSummary(archive, query("반납했찌?"), 1000), /7-9턴/);
});

test("large archive lookup retains old matching evidence instead of only its latest tail", () => {
  const summary = Array.from({ length: 120 }, (_, i) =>
    `### 기록 ${i + 1} (${i * 3 + 1}-${i * 3 + 3}턴)\n${i === 2 ? "김서윤과 도서관에서 책을 반납하기로 약속했다." : "박민준은 시장에서 일상을 보냈다. ".repeat(12)}`
  ).join("\n\n");
  const selected = selectRecallSummary(summary, query("서윤이랑 도서관에서 한 약속 기억해?"), 1400);
  assert.match(selected, /7-9턴/);
  assert.match(selected, /책을 반납/);
  assert.ok(selected.length <= 1400);
});

test("source recall recovers a concrete event omitted from summaries with role and message IDs", () => {
  const messages = [];
  for (let i = 1; i <= 45; i++) {
    messages.push({ id: `u${i}`, role: "user", content: i === 9 ? "김서윤과 도서관에서 약속대로 책을 돌려준다." : "마을을 둘러본다." });
    messages.push({ id: `a${i}`, role: "assistant", content: i === 9 ? "김서윤이 반납된 책을 받아 대여 기록을 정리했다." : "박민준이 거리를 걸었다." });
  }
  const result = buildRecallEvidence({ query: query("서윤이랑 도서관에서 약속대로 반납했지?"), messages, recentMessageIds: ["u45", "a45"] });
  assert.ok(result.turns.includes(9));
  assert.ok(result.messageIds.includes("u9"));
  assert.ok(result.messageIds.includes("a9"));
  assert.match(result.block, /대여 기록/);
  assert.match(result.block, /"role":"user"/);
  assert.ok(!result.messageIds.includes("a45"));
  assert.ok(result.block.length <= 7000);
});

test("source turn numbers exclude prologues and count unanswered inputs only once", () => {
  const messages = [
    { id: "prologue", role: "assistant", content: "도서관 소개" },
    { id: "u1", role: "user", content: "서윤에게 인사한다." },
    { id: "retry", role: "user", content: "다시 서윤에게 인사한다." },
    { id: "a1", role: "assistant", content: "김서윤이 인사했다." },
    { id: "u2", role: "user", content: "책을 돌려준다." },
    { id: "a2", role: "model", content: "김서윤이 책을 돌려받았다." },
    { id: "pending", role: "user", content: "2턴 기억해?" },
  ];
  const result = buildRecallEvidence({ query: query("2턴 기억해?"), messages });
  assert.ok(result.turns.includes(2));
  assert.ok(!result.messageIds.includes("prologue"));
  assert.ok(!result.messageIds.includes("pending"));
  assert.match(result.block, /"turn":2.*"a2"/);
  assert.equal(buildRecallEvidence({ query: query("책장을 연다"), messages }).block, "");
});

test("source excerpts obey the budget and label omitted text", () => {
  const result = buildRecallEvidence({
    query: query("서윤이랑 했던 약속 기억해?"), maxChars: 2800,
    messages: [
      { id: "u", role: "user", content: "김서윤과 약속했다." },
      { id: "a", role: "assistant", content: "김서윤은 약속을 기록했다. ".repeat(1000) },
    ],
  });
  assert.ok(result.block.length <= 2800);
  assert.match(result.block, /"excerpted":true/);
});

test("focused character history preserves old low-importance records across all characters", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE chat_character_roster(id TEXT,chatId TEXT,name TEXT,aliases TEXT,role TEXT,profile TEXT,relationshipNote TEXT,emotionNote TEXT,status TEXT,enabled INTEGER,updatedAt INTEGER);
      CREATE TABLE chat_character_turn_memories(chatId TEXT,rosterId TEXT,turnNo INTEGER,summary TEXT,evidence TEXT,memoryType TEXT,importance INTEGER);`);
    db.prepare("INSERT INTO chat_character_roster VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("seoyun", "chat-a", "김서윤", "", "", "", "", "", "", 1, 1);
    for (let i = 1; i <= 30; i++) db.prepare("INSERT INTO chat_character_turn_memories VALUES (?,?,?,?,?,?,?)").run("chat-a", "seoyun", i, `김서윤과 도서관의 ${i}번 자료를 확인했다.`, `자료 번호 ${i}`, "unresolved", 1);
    db.prepare("INSERT INTO chat_character_turn_memories VALUES (?,?,?,?,?,?,?)").run("chat-b", "seoyun", 500, "다른 채팅의 기록", "", "major_event", 3);
    const localLoad = loader({ "@/lib/db": { db } });
    const { buildDynamicCharacterContext } = localLoad("lib/dynamic_character_context.ts");
    const result = buildDynamicCharacterContext({ chatId: "chat-a", personaName: "이도현", focusText: "서윤아", graph: { personaName: "이도현", nodes: [], relations: [], affinities: [] } });
    assert.match(result.block, /도서관의 1번/);
    assert.match(result.block, /도서관의 30번/);
    assert.doesNotMatch(result.block, /다른 채팅의 기록/);
    assert.equal(result.eventCount, 30);
  } finally { db.close(); }
});

test("broad history requests enable source recall without treating ordinary actions as recall", () => {
  for (const text of ["처음부터 모든 사건을 정리해줘.", "지금까지 있었던 일을 요약해줘.", "전체 대화를 회고해줘."]) {
    assert.equal(query(text).requested, true, text);
  }
  assert.equal(query("음식을 전부 먹는다.").requested, false);
  assert.equal(query("처음부터 다시 연주한다.").requested, false);
});

test("source excerpts retain a queried fact at the end of an oversized paragraph", () => {
  const result = buildRecallEvidence({
    query: query("1턴 박민준 사망 사건 기억해?"), maxChars: 2800,
    messages: [
      { id: "u", role: "user", content: "계속 이동한다." },
      { id: "a", role: "assistant", content: "박민준은 길을 걸었다. " + "저녁 하늘에 구름이 지나갔다. ".repeat(150) + "박민준은 낙석 사고로 사망했고 장례를 치렀다." },
    ],
  });
  assert.deepEqual(result.turns, [1]);
  assert.match(result.block, /낙석 사고로 사망/);
  assert.match(result.block, /생략/);
  assert.ok(result.block.length <= 2800);
});

test("a focused person's consequential origin survives 500 turns of name-only mentions", () => {
  const summary = Array.from({ length: 167 }, (_, i) =>
    `### 기록 ${i + 1} (${i * 3 + 1}-${i * 3 + 3}턴)\n${i === 0 ? "박민준은 주인공을 증오하며 원수가 되었다. 화해는 이루어지지 않았다." : "기록관이 박민준의 이름이 적힌 공문을 정리했다. 별다른 사건은 없었다."}`
  ).join("\n\n");
  const selected = selectHybridMemory({ historySummary: summary, queryText: "박민준, 대답해.", focusNames: ["박민준"] });
  assert.ok(selected.relatedRanges.some((range) => range.startTurn === 1));
  assert.ok(selected.relatedRanges.length <= 6);
  const unrelated = selectHybridMemory({ historySummary: summary, queryText: "박민준, 대답해.", focusNames: ["김서윤"] });
  assert.ok(!unrelated.relatedRanges.some((range) => range.startTurn === 1));
});

test("a focused death record is not displaced by a newer matching topic and explicit ranges still win", () => {
  const candidates = Array.from({ length: 167 }, (_, i) => ({
    startTurn: i * 3 + 1, endTurn: i * 3 + 3,
    text: i === 0 ? "박민준은 낙석 사고로 사망했다. 장례를 치렀다." : "기록관이 박민준에게 배달되지 못한 편지를 보관했다.",
  }));
  const selected = rankMemoryRetrievalCandidates({ candidates, primaryQueryText: "박민준에게 편지를 건넨다.", focusNames: ["박민준"], maxItems: 5, maxChars: 1800 });
  assert.ok(selected.some((candidate) => candidate.startTurn === 1));
  const explicit = rankMemoryRetrievalCandidates({ candidates, primaryQueryText: "400턴 박민준 편지", focusNames: ["박민준"], maxItems: 1, maxChars: 1800 });
  assert.equal(explicit[0].startTurn, 400);
});

test("bounded broad history retains the beginning and current ending and labels omitted ranges", () => {
  const summary = Array.from({ length: 167 }, (_, i) =>
    `### 기록 ${i + 1} (${i * 3 + 1}-${i * 3 + 3}턴)\n${i === 0 ? "초기 약속의 근거를 보관했다. " : i === 166 ? "최신 사건의 결과를 확인했다. " : "장터의 일상을 기록했다. "}${"마을 풍경과 날씨를 기록했다. ".repeat(30)}`
  ).join("\n\n");
  const selected = selectBroadHistoryMemory(summary, 6000);
  assert.match(selected, /초기 약속의 근거/);
  assert.match(selected, /최신 사건의 결과/);
  assert.match(selected, /생략/);
  assert.ok(selected.length <= 6000);
  assert.equal(selectBroadHistoryMemory("짧은 전체 기억", 6000), "짧은 전체 기억");
});

test("a critical event about a different person in the same block does not reserve the focus slot", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({
    startTurn: i * 3 + 1, endTurn: i * 3 + 3,
    text: i === 0 ? "박민준은 편지를 확인했다. 김서윤은 낙석 사고로 사망했다." : "박민준은 이름이 적힌 공문을 확인했다.",
  }));
  const selected = rankMemoryRetrievalCandidates({ candidates, primaryQueryText: "박민준, 대답해.", focusNames: ["박민준"], maxItems: 3, maxChars: 1800 });
  assert.ok(!selected.some((candidate) => candidate.startTurn === 1));
});

test("broad history identifies skipped turns and never turns half a sentence into evidence", () => {
  const longSentence = "박민준이 사망했다는 이야기는 " + "누군가가 퍼뜨린 확인되지 않은 이야기로 ".repeat(100) + "명백한 거짓이었다.";
  const summary = `### 첫 기록 (1-3턴)\n${longSentence}\n\n### 중간 기록 (4-6턴)\n${"조용한 마을의 일상을 살폈다. ".repeat(60)}\n\n### 최신 기록 (7-9턴)\n현재 박민준은 도서관에서 책을 읽고 있다.`;
  for (const budget of [100, 300, 600, 1000]) {
    const selected = selectBroadHistoryMemory(summary, budget);
    assert.ok(selected.length <= budget);
    assert.doesNotMatch(selected, /박민준이 사망했다는 이야기는/);
    assert.match(selected, /1-3턴[\s\S]*생략|1-6턴[\s\S]*생략|1-9턴[\s\S]*생략/);
  }
  const legacy = selectBroadHistoryMemory(longSentence, 300);
  assert.doesNotMatch(legacy, /박민준이 사망했다는 이야기는/);
  assert.match(legacy, /생략/);
});

test("a focused pregnancy origin survives unrelated later paperwork without requiring a recall phrase", () => {
  const summary = Array.from({ length: 167 }, (_, i) =>
    `### 기록 ${i + 1} (${i * 3 + 1}-${i * 3 + 3}턴)\n${i === 0 ? "유이설은 임신했다. 병원 검사로 확정되었다." : "유이설은 서류를 검토하고 보고서를 정리했다."}`
  ).join("\n\n");
  const selected = selectHybridMemory({ historySummary: summary, queryText: "유이설, 서류를 보여줘.", focusNames: ["유이설"] });
  assert.ok(selected.relatedRanges.some(range => range.startTurn === 1));
});

test("conception and womb wording recall an earlier pregnancy confirmation with the canonical name", () => {
  const pregnancyIdentities = [{ id: "seol", name: "유이설", aliases: "이설, 유이설 사숙" }];
  const messages = [];
  for (let i = 1; i <= 300; i++) {
    messages.push({ id: `u${i}`, role: "user", content: i === 3 ? "*이 와중에 유이설 임신함*" : "서류를 정리한다." });
    messages.push({ id: `a${i}`, role: "assistant", content: "유이설은 서류를 검토했다." });
  }
  for (const current of ["이설의 잉태한 아이를 걱정하며 말을 건넨다.", "이설, 배 속 아기는 어때?", "이설의 회임 사실을 이야기한다."]) {
    const recall = buildMemoryRecallQuery({ userText: current, previousUserTexts: [], identities: pregnancyIdentities });
    assert.equal(recall.requested, true, current);
    assert.deepEqual(recall.names, ["유이설"]);
    const evidence = buildRecallEvidence({ query: recall, messages, recentMessageIds: ["u300", "a300"] });
    assert.ok(evidence.turns.includes(3), current);
    assert.match(evidence.block, /유이설 임신함/);
  }
  assert.equal(buildMemoryRecallQuery({ userText: "이설, 아이에게 장난감을 건네자.", previousUserTexts: [], identities: pregnancyIdentities }).requested, false);
});

test("pregnancy synonyms rank the confirmation above name-only events in the indexed shortlist", () => {
  const candidates = Array.from({ length: 100 }, (_, i) => ({
    startTurn: i * 3 + 1, endTurn: i * 3 + 3,
    text: i === 0 ? "유이설은 임신했다. 검사 결과를 확인했다." : "유이설은 서류를 검토하고 보고서를 보관했다.",
  }));
  const selected = rankMemoryRetrievalCandidates({ candidates, primaryQueryText: "유이설의 잉태한 아이에 관해 서류를 확인한다.", focusNames: ["유이설"], maxItems: 5, maxChars: 1800 });
  assert.ok(selected.some(candidate => candidate.startTurn === 1));
});
