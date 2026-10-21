/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const source = fs.readFileSync(path.join(__dirname, "durable_character_state.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
Function("exports", "module", "require", output)(loaded.exports, loaded, require);
const { deriveDurableCharacterCanon, buildDurableCharacterCanonBlock, guardGeneratedDurableCharacterState } = loaded.exports;
const identities = [
  { name: "박도훈", aliases: '["도훈", "박 선생"]' },
  { name: "이춘복", aliases: "춘복, 이 선생" },
  { name: "김도훈", aliases: ["김 선생"] },
];
const message = (id, role, content, turnNo) => ({ id, role, content, turnNo });
const died = message("death-3", "user", "*박도훈은 마을 입구에서 칼에 찔려 죽었다.*", 3);
const hostile = message("hostile-3", "user", "*박도훈과 이춘복은 돌이킬 수 없는 원수가 되었다.*", 3);
const derive = (messages, extra = {}) => deriveDurableCharacterCanon({ messages, identities, personaName: "이춘복", ...extra });
const guard = (text, canon = derive([died, hostile])) => guardGeneratedDurableCharacterState({ text, canon, identities, personaName: "이춘복" });

test("turn 3 death survives 500 turns and later generated survival", () => {
  const history = [died];
  for (let turn = 4; turn <= 500; turn++) {
    history.push(message(`u${turn}`, "user", "여행자들은 다음 마을로 이동했다.", turn));
    history.push(message(`a${turn}`, "assistant", "길 위에는 작은 돌과 나무가 있었다.", turn));
  }
  history.push(message("a500-live", "assistant", "박도훈은 살아서 돌아왔다. 박도훈은 환하게 웃었다.", 500));
  const canon = derive(history);
  assert.equal(canon.lifeStates.length, 1);
  assert.equal(canon.lifeStates[0].kind, "deceased");
  assert.equal(canon.lifeStates[0].turnNo, 3);
  assert.equal(canon.lifeStates[0].sourceMessageId, "death-3");
  assert.equal(canon.lifeStates[0].sourceRole, "user");
});

test("first completed assistant event is retained with its provenance", () => {
  const canon = derive([
    message("a3", "assistant", "*박도훈은 병원에 도착하기 전 숨을 거두었다.*", 3),
    message("a500", "assistant", "*박도훈은 부활했다. 박도훈은 살아 있다.*", 500),
  ]);
  assert.equal(canon.lifeStates[0].kind, "deceased");
  assert.equal(canon.lifeStates[0].sourceMessageId, "a3");
  assert.equal(canon.lifeStates[0].sourceRole, "assistant");
});

test("explicit user revival with object grammar needs no magic correction keyword", () => {
  const canon = derive([died, message("revive-500", "user", "박도훈을 부활시킨다.", 500)]);
  assert.equal(canon.lifeStates[0].kind, "alive");
  assert.equal(canon.lifeStates[0].sourceMessageId, "revive-500");
  const text = '*박도훈은 문을 열고 들어왔다.* "돌아왔어."';
  assert.equal(guard(text, canon).text, text);
});

test("user corrects an assistant death without later assistant killing them again", () => {
  const canon = derive([
    { ...died, role: "assistant" },
    message("u500", "user", "설정 정정: 박도훈은 죽은 게 아니라 살아 있다.", 500),
    message("a500", "assistant", "박도훈은 사망했다.", 500),
  ]);
  assert.equal(canon.lifeStates[0].kind, "alive");
  assert.equal(canon.lifeStates[0].sourceRole, "user");
});

test("a later explicit user death is allowed after revival", () => {
  const canon = derive([died, message("u500", "user", "박도훈을 부활시킨다.", 500), message("u501", "user", "박도훈은 결국 목숨을 잃었다.", 501)]);
  assert.equal(canon.lifeStates[0].kind, "deceased");
  assert.equal(canon.lifeStates[0].sourceMessageId, "u501");
});

test("undo removes death or restores the state before an undone revival", () => {
  assert.deepEqual(derive([]).lifeStates, []);
  const beforeRevival = [died];
  assert.equal(derive([...beforeRevival, message("revive", "user", "박도훈을 부활시킨다.", 500)]).lifeStates[0].kind, "alive");
  assert.equal(derive(beforeRevival).lifeStates[0].kind, "deceased");
});

test("normal death phrasings with intermediate causes and places are accepted", () => {
  for (const text of ["박도훈은 마을 입구에서 사망했다.", "박도훈은 칼에 찔려 죽었다.", "박도훈이 숨을 거두었다.", "박도훈은 목숨을 잃었다."]) {
    assert.equal(derive([message("u3", "user", text, 3)]).lifeStates[0]?.kind, "deceased", text);
  }
});

test("quotes, conditions, threats, reports, mistakes, memories and dreams are not current death events", () => {
  for (const text of [
    '"박도훈은 죽었다."라고 이춘복이 거짓말했다.',
    "만약 박도훈이 죽었다면 이춘복은 슬플 것이다.",
    "박도훈은 죽을지도 모른다.",
    "박도훈을 죽이겠다고 협박했다.",
    "박도훈은 사망했다는 소식을 들었다.",
    "박도훈이 죽은 줄 알았다.",
    "꿈속에서 박도훈은 죽었다.",
    "회상 장면에서 박도훈은 죽었다.",
    "박도훈은 사망하지 않았다.",
  ]) assert.deepEqual(derive([message("u3", "user", text, 3)]).lifeStates, [], text);
});

test("hypothetical or quoted revival never clears a known death", () => {
  for (const text of ['"박도훈은 부활했다."', "만약 박도훈이 부활한다면 좋겠다.", "박도훈을 부활시킬 수 있을까?", "꿈에서 박도훈은 살아 있다."]) {
    assert.equal(derive([died, message("u500", "user", text, 500)]).lifeStates[0].kind, "deceased", text);
  }
});

test("aliases identify only their canonical person and shared aliases are not guessed", () => {
  const canon = derive([message("u3", "user", "도훈은 사망했다.", 3)]);
  assert.equal(canon.lifeStates[0].name, "박도훈");
  assert.equal(guard("*김도훈은 문을 열고 들어왔다.*", canon).removed, 0);
  assert.equal(guard("*도훈은 문을 열고 들어왔다.*", canon).removed, 1);
  const ambiguous = derive([message("u3", "user", "도훈은 사망했다.", 3)], { identities: [{name:"박도훈", aliases:["도훈"]}, {name:"김도훈", aliases:["도훈"]}] });
  assert.deepEqual(ambiguous.lifeStates, []);
});

test("dead character current actions and named speaking are rejected", () => {
  for (const text of ['*박도훈은 문을 열고 들어와 웃으며 말했다.* "오랜만이야."', "박도훈은 살아 있다.", '박도훈: "안녕."']) {
    const result = guard(text);
    assert(result.removed >= 1, text);
    assert.equal(result.text, "", text);
    assert(result.violations.some((item) => item.startsWith("deceased_")));
  }
});

test("dead person's memory, ghost, dream and quoted claims remain possible", () => {
  for (const text of [
    "*회상 속에서 박도훈은 웃으며 말했다.*",
    "*박도훈의 유령은 문을 열고 들어왔다.*",
    "*꿈속에서 박도훈은 살아 있다.*",
    '이춘복은 "박도훈은 살아 있다"라는 거짓말을 들었다.',
    "*박도훈의 시신을 보며 이춘복은 고개를 숙였다.*",
    "*박도훈은 살아 있지 않다.*",
    "```INFO\n박도훈: 사망\n```",
  ]) assert.equal(guard(text).text, text, text);
});

test("hostility persists through later assistant friendship and reconciliation claims", () => {
  const canon = derive([hostile, message("a500", "assistant", "박도훈과 이춘복은 화해했다. 박도훈과 이춘복은 친구가 되었다.", 500)]);
  assert.equal(canon.relationships[0].kind, "hostile");
  assert.equal(canon.relationships[0].sourceMessageId, "hostile-3");
  assert.equal(guard("*박도훈은 이춘복을 가장 소중한 친구로 여기며 반갑게 껴안았다.*", canon).removed, 1);
});

test("first assistant hostility is also retained until a user resolves it", () => {
  const canon = derive([{ ...hostile, role: "assistant" }, message("a500", "assistant", "박도훈과 이춘복은 친구가 되었다.", 500)]);
  assert.equal(canon.relationships[0].kind, "hostile");
  assert.equal(canon.relationships[0].sourceRole, "assistant");
});

test("explicit user reconciliation or forgiveness allows warmth and preserves evidence", () => {
  for (const text of ["박도훈과 이춘복은 화해했다.", "박도훈은 이춘복을 용서했다.", "박도훈과 이춘복은 친구가 되었다."]) {
    const canon = derive([hostile, message("u500", "user", text, 500)]);
    assert.equal(canon.relationships[0].kind, "reconciled", text);
    assert.equal(canon.relationships[0].sourceMessageId, "u500");
    assert.equal(guard("*박도훈은 이춘복을 반갑게 껴안았다.*", canon).removed, 0);
    assert(buildDurableCharacterCanonBlock(canon).includes("사용자가 화해·관계 회복을 확정"));
  }
});

test("negated reconciliation, hypothetical friendship and quotes do not clear hostility", () => {
  for (const text of ["박도훈과 이춘복은 화해하지 않았다.", "만약 박도훈과 이춘복이 화해했다면 좋겠다.", '"박도훈과 이춘복은 화해했다."']) {
    assert.equal(derive([hostile, message("u500", "user", text, 500)]).relationships[0].kind, "hostile", text);
  }
});

test("hostile people can be civil or pretend to be friendly, and other pairs are unaffected", () => {
  const canon = derive([hostile]);
  for (const text of [
    "*박도훈은 이춘복에게 필요한 정보를 건넸다.*",
    "*박도훈은 이춘복에게 다정한 척하며 경계를 숨겼다.*",
    "*김도훈은 이춘복을 반갑게 껴안았다.*",
    "*박도훈은 이춘복을 용서하지 않았다.*",
  ]) assert.equal(guard(text, canon).text, text, text);
});

test("turn numbers follow user turns when explicit turn numbers are absent", () => {
  const canon = derive([{role:"user",content:"시작"}, {role:"assistant",content:"장면"}, {role:"user",content:"다음"}, {role:"assistant",content:"장면"}, {id:"third",role:"user",content:"박도훈은 사망했다."}]);
  assert.equal(canon.lifeStates[0].turnNo, 3);
});

test("a death at the end of a long paragraph or long subject clause is not truncated", () => {
  const lead = "고요한 길 위에서 여러 사건을 겪었다 ".repeat(180);
  const between = "멀리 떨어진 낯선 마을을 지나고 긴 여정을 끝낸 뒤 ".repeat(30);
  const canon = derive([message("long", "user", `${lead} 박도훈은 ${between} 사망했다.`, 3)]);
  assert.equal(canon.lifeStates[0]?.kind, "deceased");
  assert.equal(canon.lifeStates[0]?.sourceMessageId, "long");
  assert(canon.lifeStates[0].evidence.includes("박도훈"));
  assert(canon.lifeStates[0].evidence.includes("사망했다"));
  assert(canon.lifeStates[0].evidence.length <= 250);
});

test("long relationship evidence includes both identities and the actual transition", () => {
  const between = "오랫동안 지나간 일들을 하나하나 정리한 끝에 ".repeat(100);
  const canon = derive([message("long-relation", "user", `박도훈과 이춘복은 ${between} 원수가 되었다.`, 3)]);
  const evidence = canon.relationships[0]?.evidence || "";
  assert(evidence.includes("박도훈"));
  assert(evidence.includes("이춘복"));
  assert(evidence.includes("원수가 되었다"));
  assert(evidence.length <= 250);
});

test("questions about survival or reconciliation never change canonical state", () => {
  for (const text of ["박도훈은 살아 있어?", "박도훈은 살아 있니?", "박도훈은 살아 있나요", "박도훈과 이춘복은 화해했다?"]) {
    const canon = derive([died, hostile, message("question", "user", text, 500)]);
    assert.equal(canon.lifeStates[0].kind, "deceased", text);
    assert.equal(canon.relationships[0].kind, "hostile", text);
  }
});

test("legacy model role records assistant provenance", () => {
  const canon = derive([{ ...died, role: "model" }]);
  assert.equal(canon.lifeStates[0]?.sourceRole, "assistant");
});

test("a mentioned person's subordinate subject cannot transfer death to them", () => {
  const canon = derive([message("a3", "assistant", "박도훈은 친구가 죽었지만 자신은 살아남았다.", 3)]);
  assert.deepEqual(canon.lifeStates, []);
});

test("two companions hating or forgiving a third party are not enemies of each other", () => {
  for (const text of ["박도훈은 이춘복과 함께 적을 증오했다.", "박도훈과 이춘복은 적을 용서했다."]) {
    assert.deepEqual(derive([message("u3", "user", text, 3)]).relationships, [], text);
  }
});

test("being alive now does not prevent a later completed death", () => {
  const canon = derive([message("u3", "user", "박도훈은 살아 있다.", 3), message("a500", "assistant", "박도훈은 결국 낙석 사고로 사망했다.", 500)]);
  assert.equal(canon.lifeStates[0]?.kind, "deceased");
  assert.equal(canon.lifeStates[0]?.sourceMessageId, "a500");
});

test("negating reconciliation does not negate a separately stated hostile relationship", () => {
  const canon = derive([message("u3", "user", "박도훈과 이춘복은 원수이며 화해하지 않았다.", 3)]);
  assert.equal(canon.relationships[0]?.kind, "hostile");
});

test("a valid neighboring sentence survives and retains narration markers", () => {
  const result = guard("*박도훈은 문을 열고 들어왔다. 이춘복은 기록을 확인했다.*");
  assert.equal(result.text, "*이춘복은 기록을 확인했다.*");
});

test("dream or memory sentence cannot exempt a separate present-day resurrection", () => {
  const result = guard("*꿈속에서 박도훈은 웃었다. 박도훈은 문을 열고 들어왔다. 이춘복은 기록을 확인했다.*");
  assert.equal(result.text, "*꿈속에서 박도훈은 웃었다. 이춘복은 기록을 확인했다.*");
  assert.equal(result.removed, 1);
});

test("500-turn reconstruction with 100 identities is bounded and makes no I/O", (t) => {
  const roster = [...identities, ...Array.from({length:97}, (_, index) => ({name:`인물${index}`}))];
  const history = [died, ...Array.from({length:1000}, (_, index) => message(`m${index}`, index % 2 ? "assistant" : "user", "여행자들은 평범한 하루를 보냈다. 그들은 마을에서 잠시 쉬었다.", Math.ceil(index / 2) + 4))];
  const start = performance.now();
  const canon = derive(history, {identities:roster});
  const elapsed = performance.now() - start;
  t.diagnostic(`1001 messages / 100 identities: ${elapsed.toFixed(1)} ms`);
  assert.equal(canon.lifeStates[0].sourceMessageId, "death-3");
  assert(elapsed < 5000, `reconstruction unexpectedly slow: ${elapsed}ms`);
});
