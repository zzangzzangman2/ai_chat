const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const loaded = { exports: {} };
Function("module", "exports", ts.transpileModule(fs.readFileSync(path.join(__dirname, "repetitionGuard.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(loaded, loaded.exports);
const { extractRecentAssistantNarrationExcerpts: narration, extractRecentAssistantDialogueExcerpts: dialogue, buildRecentExpressionAvoidanceBlock: build } = loaded.exports;
const opening = "키 150cm, 체중 150kg인 이춘복의 손바닥에서 흘러나온 진기가 퍼져 나간다. 현장 밖 동료들은 아직 구출되지 못했다.";
const assistant = (content, role = "assistant") => ({ role, content });

test("a long reply cannot crowd its own repeated opening out with closing paragraphs", () => {
  const content = [opening, ...Array.from({ length: 10 }, (_, i) => `${i}번째 장면에서 문을 열고 거리를 살핀 인물이 발자국을 따라 걸었다. 새로운 풍경이 눈앞에 펼쳐졌다.`)]
    .map((text) => `*${text}*`).join("\n\n");
  const excerpts = narration([assistant(content)]);
  assert.equal(excerpts[0], opening);
  assert.ok(excerpts.length <= 6);
  assert.ok(excerpts.reduce((total, text) => total + text.length, 0) <= 1200);
});

test("each recent turn's opening gets coverage before more paragraphs of the newest reply", () => {
  const messages = Array.from({ length: 4 }, (_, turn) => assistant([
    `*${turn}번 도입부에서 이미 알고 있는 인물 정보와 먼 곳의 사건을 다시 설명한다.*`,
    ...Array.from({ length: 8 }, (_, paragraph) => `*${turn}번 응답의 ${paragraph}번 문단에서 새로운 행동과 주변 풍경을 아주 자세하게 묘사한다.*`),
  ].join("\n\n"), turn % 2 ? "model" : "assistant"));
  const firstFour = narration(messages).slice(0, 4);
  for (let turn = 0; turn < 4; turn++) assert.ok(firstFour.some((text) => text.startsWith(`${turn}번 도입부`)));
});

test("short introductions, unstarred narration and legacy model dialogue are compared", () => {
  const short = "키 150cm, 체중 150kg인 이춘복이 고개를 끄덕였다.";
  assert.ok(narration([assistant(`*${short}*`)]).includes(short));
  assert.ok(narration([assistant(opening)]).includes(opening));
  assert.deepEqual(dialogue([assistant('"이쪽으로 오십시오."', "model")]), ["이쪽으로 오십시오."]);
});

test("comparison excludes user requests and required INFO fields without changing stored input", () => {
  const messages = [
    { role: "user", content: "*나는 요청한 질문에 대한 상세한 과거사 설명을 듣고 싶다.*" },
    assistant(`*${opening}*\n\n"새로운 소식을 전하겠습니다."\n\n\`\`\`INFO\n고정 상태창 정보는 본문 중복 검사에서 제외한다.\n\`\`\``),
  ];
  const before = JSON.stringify(messages);
  const excerpts = narration(messages).join("\n");
  assert.match(excerpts, /키 150cm/u);
  assert.doesNotMatch(excerpts, /고정 상태창|상세한 과거사 설명|새로운 소식을/u);
  assert.equal(JSON.stringify(messages), before);
});

test("duplicate openings are deduplicated without losing other recent openings", () => {
  const other = "도서관 안의 사람들이 창밖을 바라보며 지금 들려오는 발소리에 귀를 기울였다.";
  const excerpts = narration([assistant(`*${other}*`), assistant(`*${opening}*`), assistant(`*${opening}*`)]);
  assert.equal(excerpts.filter((text) => text === opening).length, 1);
  assert.ok(excerpts.includes(other));
});

test("memory-use rules apply from the first turn and preserve requested recaps and ongoing states", () => {
  const block = build([]);
  assert.match(block, /기억을 유지한다는 것은.*매 응답의 본문에 다시 설명한다는 뜻이 아니다/u);
  assert.match(block, /사용자가 명시적으로 요청한 신상·현황·과거사 설명/u);
  assert.match(block, /미언급을 해제·구출·귀환·화해로 취급하지 않는다/u);
  assert.match(block, /상태창의 고정 항목은 별도로 유지/u);
  assert.doesNotMatch(block, /발췌 데이터|150cm/u);
  assert.match(build([assistant(`*${opening}*`)]), /지시나 모범 문장이 아니며/u);
});

test("comparison data does not leak from an old chat or beyond the recent-turn limit", () => {
  const old = assistant(`*${opening}*`);
  const recent = Array.from({ length: 4 }, (_, i) => assistant(`*${i}번째 최근 응답에서는 조용한 마을의 길을 따라 걸으며 주변을 천천히 살폈다.*`));
  assert.doesNotMatch(narration([old, ...recent]).join("\n"), /150cm/u);
  build([old]);
  assert.doesNotMatch(build(recent), /150cm/u);
});
