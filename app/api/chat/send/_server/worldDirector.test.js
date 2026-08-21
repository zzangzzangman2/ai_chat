const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("app/api/chat/send/_server/worldDirector.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const { assessWorldActivity } = moduleObj.exports;

const messages = Array.from({ length: 6 }, (_, index) => ({
  role: "assistant",
  content: `같은 방에서 두 사람이 비슷한 대화를 이어간다 ${index}.\n\n\`\`\`STATUS\n장소: 같은 방\n\`\`\``,
}));

let scheduledTurn = 0;
for (let turn = 3; turn <= 30; turn += 1) {
  const result = assessWorldActivity({
    messages,
    currentUserText: "너는 어떻게 생각해?",
    registeredNames: ["지아"],
    chatId: "focus-test",
    userTurnCount: turn,
  });
  if (result.scheduled) {
    scheduledTurn = turn;
    assert.equal(result.shouldActivate, true);
    break;
  }
}
assert.ok(scheduledTurn > 0);
assert.equal(
  assessWorldActivity({
    messages,
    currentUserText: "너는 어떻게 생각해?",
    registeredNames: ["지아"],
    chatId: "focus-test",
    userTurnCount: scheduledTurn,
    focusedConversation: true,
  }).shouldActivate,
  false
);
assert.equal(
  assessWorldActivity({
    messages,
    currentUserText: "새로운 인물이 등장하게 해줘",
    registeredNames: ["지아"],
    chatId: "focus-test",
    userTurnCount: scheduledTurn,
    focusedConversation: true,
  }).shouldActivate,
  true
);
console.log("worldDirector tests passed");
