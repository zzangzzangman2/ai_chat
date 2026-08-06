/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuardModule() {
  const sourcePath = path.join(__dirname, "recognition_consistency_guard.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    require
  );
  return loaded.exports;
}

const {
  findRecognitionContradiction,
  removeRecognitionContradictionPassages,
} = loadGuardModule();

const recognition = [
  {
    characterId: "jinwoo-id",
    characterName: "정진우",
    characterAliases: ["진우", "오빠"],
    firstInteractionTurn: 41,
    lastInteractionTurn: 88,
    evidence: "정진우와 이춘복이 직접 대면해 여러 차례 대화하고 다퉜다.",
  },
  {
    characterId: "arin-id",
    characterName: "정아린",
    characterAliases: ["아린"],
    firstInteractionTurn: 59,
    lastInteractionTurn: 71,
    evidence: "정아린과 이춘복이 직접 대면했다.",
  },
];

function find(text, overrides = {}) {
  return findRecognitionContradiction({
    text,
    personaName: "이춘복",
    personaAliases: ["춘복", "주인공"],
    currentUserText: "*아린에게 다가간다* 이 할애비가 응원하마.",
    sceneCharacterNames: ["정진우", "정아린"],
    recognition,
    ...overrides,
  });
}

test("catches a known speaker treating a role-noun persona as a stranger", () => {
  const result = find([
    "*정아린은 다가오는 노인을 보고 몸을 굳혔다.*",
    "",
    "*정진우가 아린의 앞을 가로막고 눈앞의 노인을 향해 분노를 토해냈다.*",
    "",
    '"당신 뭐야! 당장 떨어져!"',
  ].join("\n"));

  assert.equal(result?.characterName, "정진우");
  assert.match(result?.matchedText || "", /당신\s*뭐야/u);
});

test("resolves a stored character alias as the speaker", () => {
  const result = find([
    "*오빠가 노인을 향해 소리쳤다.*",
    "",
    '"그쪽은 누구야?"',
  ].join("\n"));

  assert.equal(result?.characterName, "정진우");
});

test("resolves speaker attribution written after the dialogue", () => {
  const result = find('"당신은 누구십니까?" 정진우가 물었다.');
  assert.equal(result?.characterName, "정진우");
});

test("catches particle, contraction and implicit-address variants", () => {
  for (const dialogue of [
    '"당신이 누구냐?"',
    '"넌 대체 누구야?"',
    '"누구세요?"',
  ]) {
    const result = find(`*정진우가 노인을 향해 물었다.*\n\n${dialogue}`);
    assert.equal(result?.characterName, "정진우", dialogue);
  }
});

test("resolves a stored persona alias without requiring the canonical name", () => {
  const result = find("*정진우는 춘복을 처음 보는 사람처럼 대했다.*");
  assert.equal(result?.characterName, "정진우");
});

test("still catches explicit named-persona recognition contradictions", () => {
  const result = find("*정진우는 이춘복을 낯선 사람처럼 바라보며 경계했다.*");
  assert.equal(result?.characterName, "정진우");
});

test("does not confuse the known character target with the speaker", () => {
  const result = find([
    "*이춘복이 정진우에게 물었다.*",
    "",
    '"당신 누구야?"',
  ].join("\n"));
  assert.equal(result, null);
});

test("allows identity questions aimed at an explicitly named third party", () => {
  const result = find(
    [
      "*정진우가 민수를 향해 물었다.*",
      "",
      '"당신 누구야?"',
    ].join("\n"),
    { sceneCharacterNames: ["정진우", "정아린", "민수"] }
  );
  assert.equal(result, null);
});

test("keeps a named third-party question valid even when the persona is nearby", () => {
  const result = find(
    [
      "*정진우가 이춘복 옆에 선 민수를 향해 물었다.*",
      "",
      '"당신 누구야?"',
    ].join("\n"),
    { sceneCharacterNames: ["정진우", "정아린", "민수"] }
  );
  assert.equal(result, null);
});

test("allows a genuine new third party introduced by the user", () => {
  const result = find(
    [
      "*정진우가 새로 온 남자를 가로막고 물었다.*",
      "",
      '"당신 누구야?"',
    ].join("\n"),
    { currentUserText: "*처음 보는 남자를 데리고 방으로 들어온다*" }
  );
  assert.equal(result, null);
});

test("does not confuse unknown motives with failure to recognize a person", () => {
  const result = find([
    "*정진우가 노인을 노려보며 경고했다.*",
    "",
    '"당신이 왜 여기 있는지는 모르겠지만 아린에게서 떨어져."',
  ].join("\n"));
  assert.equal(result, null);
});

test("last-resort filtering removes an alias-based contradiction passage", () => {
  const result = removeRecognitionContradictionPassages({
    text: [
      "*정진우가 노인을 향해 소리쳤다.*",
      "",
      '"당신 뭐야?"',
      "",
      "*아린은 숨을 골랐다.*",
    ].join("\n"),
    personaName: "이춘복",
    currentUserText: "*아린에게 다가간다*",
    sceneCharacterNames: ["정진우", "정아린"],
    recognition,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /당신\s*뭐야/u);
  assert.match(result.text, /아린은 숨을 골랐다/u);
});
