const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("lib/status_panel_continuity.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
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
console.log("status_panel_continuity tests passed");
