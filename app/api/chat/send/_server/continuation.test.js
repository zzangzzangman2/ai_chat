const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const file = path.join(__dirname, "continuation.ts");
const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const textPolicyFile = path.join(__dirname, "textPolicy.ts");
const textPolicyJs = ts.transpileModule(fs.readFileSync(textPolicyFile, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const textPolicyModule = { exports: {} };
Function("exports", "module", "require", textPolicyJs)(textPolicyModule.exports, textPolicyModule, require);

const continuationModule = { exports: {} };
Function("exports", "module", "require", js)(
  continuationModule.exports,
  continuationModule,
  (id) => (id === "./textPolicy" ? textPolicyModule.exports : require(id))
);
const { buildManualContinuationPrompt, mergeManualContinuationBase } = continuationModule.exports;

test("manual continuation contains only the selected assistant tail", () => {
  const tail = '*재판장이 판결문을 내려다보았다.*\n\n"주문을 선고합니다."';
  const prompt = buildManualContinuationPrompt({ continueTail: tail, targetChars: 1200 });

  assert.match(prompt, /\[직전 어시스턴트 출력 끝부분\]/);
  assert.match(prompt, /주문을 선고합니다/);
  assert.doesNotMatch(prompt, /\[최근 대화\]|CURRENT USER|PREVIOUS USER/);
  assert.doesNotMatch(prompt, /사용자 입력 끝부분/);
});

test("continuation removes repeated tail and keeps one status panel at the end", () => {
  const repeatedTail = '"주문을 선고합니다."';
  const base = [
    "*재판장이 판결문을 내려다보았다.*",
    "",
    repeatedTail,
    "",
    "```상태",
    "장소: 법정",
    "```",
  ].join("\n");
  const delta = [repeatedTail, "", "*재판장이 다음 주문을 읽기 시작했다.*"].join("\n");
  const merged = mergeManualContinuationBase(base, delta);

  assert.equal((merged.match(/주문을 선고합니다/gu) || []).length, 1);
  assert.equal((merged.match(/```상태/gu) || []).length, 1);
  assert.match(merged, /다음 주문을 읽기 시작했다\.\*\n\n```상태/);
  assert.ok(merged.endsWith("```"));
});
