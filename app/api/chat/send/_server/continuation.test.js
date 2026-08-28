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
const {
  buildManualContinuationPrompt,
  mergeManualContinuationBase,
  selectManualContinuationAnchor,
} = continuationModule.exports;

test("manual continuation contains only the selected assistant tail", () => {
  const tail = '*재판장이 판결문을 내려다보았다.*\n\n"주문을 선고합니다."';
  const prompt = buildManualContinuationPrompt({ continueTail: tail, targetChars: 1200 });

  assert.match(prompt, /\[이어쓰기 기준점 — 이미 출력 완료된 마지막 문단들\]/);
  assert.match(prompt, /주문을 선고합니다/);
  assert.doesNotMatch(prompt, /\[최근 대화\]|CURRENT USER|PREVIOUS USER/);
  assert.doesNotMatch(prompt, /사용자 입력 끝부분/);
});

test("manual continuation anchor uses the actual endpoint instead of an older unfinished beat", () => {
  const base = [
    '*재판장이 판결문을 내려다보았다.*',
    '',
    '"주문."',
    '',
    '*방청석에서 이미 첫 반응이 터져 나왔다. 이수진은 박지아를 끌어안고 울었고 박도훈은 얼굴을 감쌌다.*',
    '',
    '*박지훈은 눈가를 닦고 굳게 고개를 들었다.*',
    '',
    '```STATUS',
    '장소: 법정',
    '```',
  ].join('\n');
  const anchor = selectManualContinuationAnchor(base, { maxChars: 1200, maxParagraphs: 2 });
  const prompt = buildManualContinuationPrompt({ continueTail: anchor, targetChars: 1200 });

  assert.doesNotMatch(anchor, /주문|판결문을 내려다/);
  assert.match(anchor, /방청석에서 이미 첫 반응/);
  assert.match(anchor, /박지훈은 눈가를 닦고/);
  assert.doesNotMatch(anchor, /STATUS|장소: 법정/);
  assert.match(prompt, /유일한 시간적 끝점/);
  assert.match(prompt, /같은 인물의 같은 반응/);
});

test("manual continuation anchor also handles novel lines without blank separators", () => {
  const base = [
    '"주문."',
    '*첫 번째 반응은 이미 끝났다.*',
    '*두 번째 반응도 이미 끝났다.*',
  ].join('\n');
  const anchor = selectManualContinuationAnchor(base, { maxParagraphs: 2 });

  assert.doesNotMatch(anchor, /주문/);
  assert.match(anchor, /첫 번째 반응/);
  assert.match(anchor, /두 번째 반응/);
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
