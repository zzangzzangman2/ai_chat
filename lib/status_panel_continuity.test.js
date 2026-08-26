const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("lib/status_panel_continuity.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const guardSource = fs.readFileSync("lib/turn_completion_guard.ts", "utf8");
const guardJs = ts.transpileModule(guardSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const guardModule = { exports: {} };
new Function("require", "module", "exports", guardJs)(require, guardModule, guardModule.exports);
const moduleObj = { exports: {} };
const localRequire = (id) => (id === "./turn_completion_guard" ? guardModule.exports : require(id));
new Function("require", "module", "exports", js)(localRequire, moduleObj, moduleObj.exports);
const { buildPreviousStatusPanelSnapshot, mergeStatusPanelContinuity } = moduleObj.exports;

const oldFull = "```상태\n날짜: 22:32\n장소: 방\n빙의: 1일차\n호감도: 수진 -100 | 도훈 -100 | 지아 -100 | 지은 -100 | 지훈 -100\n```";
const oldPartial = "```상태\n날짜: 22:34\n장소: 방\n빙의: 1일차\n호감도: 지아 -99\n```";
const snapshot = buildPreviousStatusPanelSnapshot([
  { role: "assistant", content: `본문\n\n${oldFull}` },
  { role: "assistant", content: `본문\n\n${oldPartial}` },
]);
assert.match(snapshot, /날짜: 22:34/);
assert.match(snapshot, /호감도: 지아 -99 \| 수진 -100 \| 도훈 -100 \| 지은 -100 \| 지훈 -100/);

const repaired = mergeStatusPanelContinuity({
  currentText: '"대사"\n\n```상태\n날짜: 22:36\n장소: 방\n호감도: 지아 -98\n```',
  previousPanel: snapshot,
});
assert.match(repaired.text, /빙의: 1일차/);
assert.equal((repaired.text.match(/```상태/g) || []).length, 1);
assert.match(repaired.text, /호감도: 지아 -98 \| 수진 -100 \| 도훈 -100 \| 지은 -100 \| 지훈 -100/);
const appended = mergeStatusPanelContinuity({
  currentText: '지문\n\n"대사"',
  previousPanel: snapshot,
  appendWhenMissing: true,
});
assert.equal(appended.appended, true);
assert.match(appended.text, /"대사"\n\n```상태/);
assert.match(appended.text, /호감도: 지아 -99 \| 수진 -100 \| 도훈 -100 \| 지은 -100 \| 지훈 -100/);
assert.equal(
  mergeStatusPanelContinuity({ currentText: "상태창 없는 본문", previousPanel: snapshot }).changed,
  false
);

const glued = mergeStatusPanelContinuity({
  currentText: '"대답"```상태\n날짜: 22:40\n장소: 거실\n호감도: 지아 -97\n```',
  previousPanel: snapshot,
  appendWhenMissing: true,
});
assert.equal(glued.appended, false);
assert.equal((glued.text.match(/```상태/g) || []).length, 1);
assert.match(glued.text, /"대답"\n\n```상태/);
assert.match(glued.text, /날짜: 22:40/);

const deduped = mergeStatusPanelContinuity({
  currentText: `"대답"${oldPartial}\n\n${oldFull}`,
  previousPanel: snapshot,
  appendWhenMissing: true,
});
assert.equal((deduped.text.match(/```상태/g) || []).length, 1);
assert.match(deduped.text, /날짜: 22:34/);
console.log("status_panel_continuity tests passed");
