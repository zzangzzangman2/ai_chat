/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadGuard() {
  const source = fs.readFileSync(
    path.join(__dirname, "authority_claim_consistency_guard.ts"),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", output)(loaded.exports, loaded, require);
  return loaded.exports;
}

const { isAuthorityClaimContext, removeUnsupportedAuthorityClaims } = loadGuard();

test("detects police and investigator requests as authority context", () => {
  assert.equal(isAuthorityClaimContext("형사가 기록을 읽었다."), true);
  assert.equal(isAuthorityClaimContext("재판장이 판결문을 읽었다."), true);
  assert.equal(isAuthorityClaimContext("둘은 거실에서 대화했다."), false);
});

test("a commentary request and later blog photos cannot become a live crime broadcast", () => {
  const source = [
    "*재판장이 판결문을 내려다보았다.*",
    '"나아가 그 범행 과정을 불특정 다수에게 생중계했습니다."',
  ].join("\n");
  const result = removeUnsupportedAuthorityClaims({
    text: source,
    trustedUserTexts: [
      "지은아 너는 저거 중계 좀 해, 해설위원처럼.",
      "성행위 내용을 인터넷 블로그에 올렸고 사진들도 올려놓았다.",
    ],
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /생중계/u);
  assert.ok(result.claimTypes.includes("live_public_broadcast"));
});

test("a later photo upload cannot ground invented camera footage or real-time transmission", () => {
  const source =
    '검사는 "직접 설치한 카메라로 범행 영상을 해외 서버에 실시간 송출했습니다."라고 낭독했다.';
  const result = removeUnsupportedAuthorityClaims({
    text: source,
    trustedUserTexts: [
      "범행 내용을 블로그에 적었고 사진들도 인터넷에 올려놓았다.",
    ],
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /카메라|영상|실시간\s*송출/u);
  assert.ok(result.claimTypes.includes("live_public_broadcast"));
  assert.ok(result.claimTypes.includes("crime_video_distribution"));
});

test("an explicitly user-authored live broadcast fact remains available", () => {
  const source = '재판장은 "피고인이 범행을 전 세계에 생중계했습니다."라고 말했다.';
  const result = removeUnsupportedAuthorityClaims({
    text: source,
    trustedUserTexts: ["피고인은 그 범행을 전 세계에 생중계했다."],
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("removes invented counts, durations, medical outcomes, and repeated patterns", () => {
  const source = [
    '형사가 기록을 읽었다. "파악된 피해자만 두 자릿수입니다."',
    '"감금은 며칠에서 몇 주씩 이어졌습니다."',
    '"생존자 대부분이 장기 파열과 하반신 마비를 입었습니다."',
    '"그리고 피해자마다 항상 낙인을 남겼습니다."',
    '"확인된 도주 경위부터 말씀드리겠습니다."',
  ].join("\n");
  const result = removeUnsupportedAuthorityClaims({
    text: source,
    trustedUserTexts: ["형사에게 확인된 도주 경위를 설명하라고 했다."],
    authorityContext: true,
  });

  assert.doesNotMatch(result.text, /두\s*자릿수|몇\s*주|장기\s*파열|하반신\s*마비|항상\s*낙인/u);
  assert.match(result.text, /도주 경위/u);
  assert.ok(result.removed >= 4);
});

test("a user complaint naming a hallucination does not ground it", () => {
  const result = removeUnsupportedAuthorityClaims({
    text: '형사가 말했다. "그는 하반신 마비 피해자를 만들었습니다."',
    trustedUserTexts: ["왜 하지도 않은 하반신 마비를 지어내는 거야"],
    authorityContext: true,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /하반신\s*마비/u);
});

test("a request to list crimes is scope, not evidence that a crime occurred", () => {
  const result = removeUnsupportedAuthorityClaims({
    text: '형사가 말했다. "성폭행 혐의도 확인됐습니다."',
    trustedUserTexts: ["형사한테 지금까지 성범죄를 전부 자세히 설명하라고 해"],
    authorityContext: true,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /성폭행/u);
});

test("a generic request for all charges cannot ground a newly named charge", () => {
  const result = removeUnsupportedAuthorityClaims({
    text: '형사가 말했다. "추가 죄명은 방화 혐의입니다."',
    trustedUserTexts: ["형사에게 모든 죄명을 자세히 설명하라고 해"],
    authorityContext: true,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /방화|혐의/u);
});

test("an officer may explicitly say that no charge has been established", () => {
  const source = '형사가 말했다. "아직 추가 혐의는 확인되지 않았습니다."';
  const result = removeUnsupportedAuthorityClaims({
    text: source,
    trustedUserTexts: [],
    authorityContext: true,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("exact user-authored high-impact facts remain available", () => {
  const source = '형사가 말했다. "피해자는 3명이고 탈옥 기록도 확인됐습니다."';
  const result = removeUnsupportedAuthorityClaims({
    text: source,
    trustedUserTexts: ["피해자는 3명이다. 그는 탈옥했다."],
    authorityContext: true,
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("different victim counts do not cross-ground one another", () => {
  const result = removeUnsupportedAuthorityClaims({
    text: '경찰은 "피해자가 12명입니다."라고 발표했다.',
    trustedUserTexts: ["피해자는 2명이다."],
    authorityContext: true,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /12명/u);
});

test("a high-impact fact about one character cannot ground a police claim about another", () => {
  const result = removeUnsupportedAuthorityClaims({
    text: '형사가 말했다. "이춘복은 피해자를 하반신 마비로 만들었습니다."',
    trustedUserTexts: ["희찬은 사고로 하반신 마비가 됐다."],
    identities: [
      { name: "이춘복", isPersona: true },
      { name: "희찬" },
    ],
    authorityContext: true,
  });

  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.text, /하반신\s*마비/u);
});

test("ordinary non-authority prose is byte-for-byte transparent", () => {
  const source = "비가 내렸다.\n\n두 사람은 말없이 창밖을 보았다.\n";
  const result = removeUnsupportedAuthorityClaims({
    text: source,
    trustedUserTexts: [],
  });

  assert.equal(result.removed, 0);
  assert.equal(result.text, source);
});

test("unsupported official history is also removed from status fences", () => {
  const result = removeUnsupportedAuthorityClaims({
    text: "```STATUS\n범죄 기록: 피해자 수십 명\n```\n",
    trustedUserTexts: [],
    authorityContext: true,
  });

  assert.equal(result.removed, 1);
  assert.equal(result.text, "```STATUS\n```\n");
});
