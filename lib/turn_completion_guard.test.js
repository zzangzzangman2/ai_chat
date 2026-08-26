const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync("lib/turn_completion_guard.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const { assessTurnCompletion, splitTrailingPanels } = moduleObj.exports;

test("detects a short STOP and an incomplete plural response", () => {
  const raw = [
    '*두 사람은 질문을 듣고 서로를 바라보았다.*',
    '',
    '"저는 혜진이라고 생각해요."```상태',
    '날짜: 10:07',
    '장소: 거실',
    '```',
  ].join("\n");
  const result = assessTurnCompletion({
    text: raw,
    currentUserText: "너네 학교에서 제일 예쁜 애가 누구야?",
    minNarrativeChars: 300,
    finishReason: "STOP",
  });

  assert.equal(result.panels.length, 1);
  assert.equal(result.dialogueCount, 1);
  assert.deepEqual(result.reasons, ["SHORT_BODY", "PLURAL_RESPONSE_INCOMPLETE"]);
  assert.equal(result.needsRecovery, true);
  assert.doesNotMatch(result.body, /```상태/u);
});

test("peels duplicate panels and accepts an opening fence glued to dialogue", () => {
  const text = [
    '"첫 대답"```상태',
    '날짜: 10:07',
    '```',
    '',
    '```상태',
    '날짜: 10:06',
    '```',
  ].join("\n");
  const result = splitTrailingPanels(text);

  assert.equal(result.body, '"첫 대답"');
  assert.equal(result.panels.length, 2);
  assert.match(result.panels[0].fence, /10:07/u);
  assert.match(result.panels[1].fence, /10:06/u);
});

test("does not request recovery for a complete plural response", () => {
  const result = assessTurnCompletion({
    text: '*둘은 차례로 답했다.*\n\n"제 답이에요."\n\n"저도 같은 답이에요."',
    currentUserText: "둘 다 대답해봐",
    minNarrativeChars: 20,
    finishReason: "STOP",
  });

  assert.equal(result.needsRecovery, false);
  assert.deepEqual(result.reasons, []);
});

test("empty provider output is recoverable", () => {
  const result = assessTurnCompletion({
    text: "",
    currentUserText: "계속해",
    minNarrativeChars: 300,
    finishReason: "MAX_TOKENS",
  });

  assert.equal(result.needsRecovery, true);
  assert.deepEqual(result.reasons, ["MAX_TOKENS", "EMPTY_BODY"]);
});
