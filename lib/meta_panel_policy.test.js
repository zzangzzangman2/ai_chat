const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const file = path.join(__dirname, "meta_panel_policy.ts");
const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleRef = { exports: {} };
Function("exports", "module", "require", js)(moduleRef.exports, moduleRef, require);
const {
  supportsAbilityViewQuickCommand,
  usesEventOnlyMetaPolicy,
} = moduleRef.exports;

test("event-only meta policy is explicit and whitespace tolerant", () => {
  assert.equal(usesEventOnlyMetaPolicy("[제작자 메타 패널 정책: EVENT_ONLY]"), true);
  assert.equal(usesEventOnlyMetaPolicy("제작자 메타 패널 정책 : event-only"), true);
  assert.equal(usesEventOnlyMetaPolicy("퀘스트를 가끔 표시한다"), false);
});

test("ability quick command is exposed only by an explicit preset marker", () => {
  assert.equal(supportsAbilityViewQuickCommand("[빠른 명령: 능력치 보기]"), true);
  assert.equal(supportsAbilityViewQuickCommand("능력치는 관찰과 추론으로 구성된다"), false);
});

