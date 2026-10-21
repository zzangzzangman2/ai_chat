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

test("a canonical deceased name authenticates its unique alias", () => {
  const text = "도훈의 죽음 뒤 마을은 조용해졌다.";
  const result = removeUnsupportedVitalStatusClaims({text, identities, trustedUserTexts:[], establishedDeceasedNames:["박도훈"]});
  assert.equal(result.text, text);
  assert.equal(result.removed, 0);
});

test("a user-established death authenticates a unique alias without summary evidence", () => {
  const text = "도훈의 죽음을 확인했다.";
  const result = removeUnsupportedVitalStatusClaims({text, identities, trustedUserTexts:["박도훈은 현장에서 사망했다."]});
  assert.equal(result.text, text);
});

test("an ambiguous alias cannot transfer one character's death to another", () => {
  const result = removeUnsupportedVitalStatusClaims({text:"도훈의 죽음을 확인했다.", identities:[{name:"박도훈",aliases:["도훈"]},{name:"김도훈",aliases:["도훈"]}],trustedUserTexts:[],establishedDeceasedNames:["박도훈"]});
  assert.equal(result.removed, 1);
});

test("historical living scenes retain the existing default behavior", () => {
  const text = "박도훈은 살아 있다. 박도훈은 웃으며 문을 열었다.";
  const result = removeUnsupportedVitalStatusClaims({text, identities, trustedUserTexts:[],establishedDeceasedNames:["박도훈"]});
  assert.equal(result.text,text);
  assert.equal(result.removed,0);
});

test("unrelated streamed prose does not read user history for the entire roster", () => {
  let reads = 0;
  const largeRoster = [...identities, ...Array.from({length:99}, (_, index) => ({name:`인물${index}`,aliases:[`별칭${index}`]}))];
  const history = Array.from({length:500}, () => "여행자들은 평범한 하루를 보냈다.");
  const text = "박도훈은 창밖을 바라보았다. 멀리서 새가 날아갔다.";
  const result = removeUnsupportedVitalStatusClaims({
    text, identities:largeRoster,
    get trustedUserTexts() { reads++; return history; },
  });
  assert.equal(result.text,text);
  assert.equal(reads,0);
});

test("a canon-established alias needs no user-history scan", () => {
  let reads = 0;
  const text = "도훈의 죽음을 확인했다.";
  const result = removeUnsupportedVitalStatusClaims({
    text, identities, establishedDeceasedNames:["박도훈"],
    get trustedUserTexts() { reads++; return ["박도훈은 사망했다."]; },
  });
  assert.equal(result.text,text);
  assert.equal(reads,0);
});

test("repeated claims and aliases share one lazy evidence lookup", () => {
  let reads = 0;
  const text = "도훈의 죽음을 확인했다. 박도훈의 죽음 뒤 마을은 조용했다. 도훈은 사망했다.";
  const result = removeUnsupportedVitalStatusClaims({
    text, identities,
    get trustedUserTexts() { reads++; return ["박도훈은 현장에서 사망했다."]; },
  });
  assert.equal(result.text,text);
  assert.equal(reads,1);
});

test("repeated unsupported aliases cache the negative result as well", () => {
  let reads = 0;
  const result = removeUnsupportedVitalStatusClaims({
    text:"도훈은 사망했다. 박도훈은 사망했다. 도훈의 죽음을 확인했다.", identities,
    get trustedUserTexts() { reads++; return ["박도훈은 조용히 앉아 있었다."]; },
  });
  assert.equal(result.text,"");
  assert.equal(reads,1);
});
