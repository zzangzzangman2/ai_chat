/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "vital_status_consistency_guard.ts"), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
Function("exports", "module", "require", output)(loaded.exports, loaded, require);
const { removeUnsupportedVitalStatusClaims } = loaded.exports;

const identities = [{ name: "박도훈", aliases: ["도훈"] }];

test("a hypothetical suicide threat cannot become a confirmed death", () => {
  const result = removeUnsupportedVitalStatusClaims({
    text: "박도훈의 죽음을 빌미로 협박했다. 아빠의 참혹한 죽음이 떠올랐다.",
    trustedUserTexts: ["아빠가 들으면 자살하실지도 몰라. 너 아빠 없는 거 싫지?"],
    identities,
  });
  assert.equal(result.removed, 2);
  assert.equal(result.text, "");
  assert.equal(result.subjects.includes("박도훈"), true);
  assert.equal(result.subjects.includes("아빠"), true);
});

test("an explicitly user-established death is retained", () => {
  const result = removeUnsupportedVitalStatusClaims({
    text: "박도훈의 죽음 뒤 가족은 침묵했다.",
    trustedUserTexts: ["박도훈은 현장에서 사망했다."],
    identities,
  });
  assert.equal(result.removed, 0);
});

test("a continuity-ledger death is retained", () => {
  const result = removeUnsupportedVitalStatusClaims({
    text: "숨진 박도훈의 기록을 확인했다.",
    trustedUserTexts: [],
    identities,
    establishedDeceasedNames: ["박도훈"],
  });
  assert.equal(result.removed, 0);
});

test("ordinary threats and survival statements remain untouched", () => {
  const text = "아빠가 죽을지도 모른다. 하지만 박도훈은 살아 있다.";
  const result = removeUnsupportedVitalStatusClaims({ text, trustedUserTexts: [], identities });
  assert.equal(result.removed, 0);
  assert.equal(result.text, text);
});
