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
