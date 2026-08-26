/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuard() {
  const source = fs.readFileSync(
    path.join(__dirname, "legal_status_consistency_guard.ts"),
    "utf8"
  );
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

const { removeUnsupportedLegalStatusClaims } = loadGuard();
const identities = [
  { name: "이춘복", aliases: ["춘복"], isPersona: true },
  { name: "박민철", aliases: [], isPersona: false },
];

test("an investigation relationship cannot be promoted to suspect status", () => {
  const source = [
    "박민철은 이춘복의 앞을 막아 섰다.",
    '"이춘복 씨, 당신 같은 피의자 신분의 관련자가 들어올 곳이 아닙니다!"',
    "그는 방문 목적부터 확인하려 했다.",
  ].join(" ");
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: ["이춘복은 이웃 주민으로 병문안을 왔다."],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /피의자/u);
  assert.match(result.text, /방문 목적부터 확인/u);
});

test("explicit user-authored suspect conversion preserves the status", () => {
  const source = '박민철이 말했다. "이춘복 씨는 이제 피의자 신분입니다."';
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: ["이춘복이 피의자로 입건됐다."],
    identities,
  });

  assert.equal(result.removed, 0);
  assert.match(result.text, /피의자 신분/u);
});

test("second-person status claims resolve to the persona", () => {
  const source = '"당신은 피의자입니다. 물러서세요."';
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: [],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /피의자/u);
});

test("ordinary suspicion and access control remain untouched", () => {
  const source = "박민철은 이춘복의 방문 목적을 의심하며 병실 출입을 막았다.";
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: [],
    identities,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("a status assigned to one named character is not copied to another", () => {
  const source = "박민철은 피의자 신분이고 이춘복은 병문안을 왔다.";
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: ["박민철이 피의자로 입건됐고 이춘복이 이를 지켜봤다."],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /이춘복은.*피의자/u);
});

test("legal guard is byte-for-byte transparent when there is no redaction", () => {
  const source = "*복도에 발소리가 울렸다.*\n\n\"병문안을 왔습니다.\"\n\n방문 목적을 확인했다.\n";
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: [],
    identities,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("legal guard preserves paragraph spacing around a removed claim", () => {
  const source = "*복도에 발소리가 울렸다.*\n\n\"당신은 피의자입니다.\"\n\n방문 목적을 확인했다.";
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: [],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.equal(result.text, "*복도에 발소리가 울렸다.*\n\n방문 목적을 확인했다.");
});

test("an arrest established only by narration survives the guard", () => {
  // 실제 사고: 구속은 서술로만 일어났고 사용자는 그 단어를 친 적이 없었다.
  // 근거를 사용자 입력으로만 좁혔더니 요약 단계에서 구속 문장이 통째로 지워지고
  // 장기기억에는 더 약한 표현만 남았다.
  const narration = "*이춘복은 그날 밤 구속되었다.* 유치장 문이 닫혔다.";
  const summary = "이춘복은 현재 구속 상태이며 조사를 받고 있다.";

  const withoutNarration = removeUnsupportedLegalStatusClaims({
    text: summary,
    trustedUserTexts: [],
    identities,
  });
  assert.equal(withoutNarration.removed, 1, "근거가 아예 없으면 지우는 동작은 유지된다");

  const withNarration = removeUnsupportedLegalStatusClaims({
    text: summary,
    trustedUserTexts: [],
    trustedNarrationTexts: [narration],
    identities,
  });
  assert.equal(withNarration.removed, 0);
  assert.equal(withNarration.text, summary);
  assert.match(withNarration.text, /구속 상태/u);
});

test("narration evidence does not license a status nobody established", () => {
  const narration = "*이춘복은 참고인으로 잠깐 이야기를 나눴다.*";
  const result = removeUnsupportedLegalStatusClaims({
    text: "이춘복은 수배 중이다.",
    trustedUserTexts: [],
    trustedNarrationTexts: [narration],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /수배/u);
});

test("user input and narration are both accepted as evidence", () => {
  const result = removeUnsupportedLegalStatusClaims({
    text: "이춘복은 구속 상태다.",
    trustedUserTexts: ["이춘복 구속영장 나왔대"],
    trustedNarrationTexts: [],
    identities,
  });

  assert.equal(result.removed, 0);
});

test("a legal status predicate inherits the named subject from the previous sentence", () => {
  const result = removeUnsupportedLegalStatusClaims({
    text: '"그놈 이름은 이춘복입니다. 1급 수배자죠."',
    trustedUserTexts: [],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /수배자/u);
  assert.match(result.text, /이춘복/u);
});

test("a grounded wanted status survives across a sentence boundary", () => {
  const source = '"그놈 이름은 이춘복입니다. 1급 수배자죠."';
  const result = removeUnsupportedLegalStatusClaims({
    text: source,
    trustedUserTexts: ["이춘복에게 수배령이 내려졌다."],
    identities,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("asking an officer to call someone wanted does not establish wanted status", () => {
  const result = removeUnsupportedLegalStatusClaims({
    text: '"이춘복은 수배자입니다."',
    trustedUserTexts: ["형사에게 이춘복을 수배자라고 말하라고 해"],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /수배자/u);
});

test("unsupported legal status is removed from a status fence", () => {
  const result = removeUnsupportedLegalStatusClaims({
    text: "```STATUS\n이춘복: 수배자\n```",
    trustedUserTexts: [],
    identities,
  });

  assert.equal(result.removed, 1);
  assert.equal(result.text, "```STATUS\n\n```");
});
