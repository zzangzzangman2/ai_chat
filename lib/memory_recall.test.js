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
