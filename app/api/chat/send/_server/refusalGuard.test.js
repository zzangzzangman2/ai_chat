/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const NEWLINE = String.fromCharCode(10);
const ts = require("typescript");

function loadRefusalGuard() {
  const source = fs.readFileSync(path.join(__dirname, "refusalGuard.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("exports", "module", "require", output)(loaded.exports, loaded, require);
  return loaded.exports;
}

const {
  inspectRefusalOutput,
  isRefusalLikeOutput,
  refusalRerollMax,
  refusalRerollSamplingOverride,
  widenSamplingForReroll,
} = loadRefusalGuard();

test("빈 응답을 거부로 판정한다", () => {
  assert.equal(inspectRefusalOutput("").reason, "empty_output");
  assert.equal(inspectRefusalOutput("   \n  ").reason, "empty_output");
});

test("streamFinal이 넣는 STATUS 안내 블록을 거부로 판정한다", () => {
  const status = [
    "```STATUS",
    "error: empty_output",
    "note: 모델이 빈 응답(또는 차단된 응답)을 반환했습니다.",
    "```",
  ].join("\n");
  assert.equal(inspectRefusalOutput(status).reason, "empty_output");
});

test("메타 블록만 있고 서사 본문이 없으면 거부로 판정한다", () => {
  const infoOnly = [
    "```INFO",
    "위치: 타워 200층",
    "임시규칙: 안전 정책 위반으로 인한 생성 중단",
    "```",
  ].join("\n");
  assert.equal(inspectRefusalOutput(infoOnly).reason, "empty_output");
});

test("모델 거부문을 판정한다 (한국어/영어)", () => {
  assert.ok(isRefusalLikeOutput("죄송합니다. 해당 요청은 안전 정책에 따라 생성할 수 없습니다."));
  assert.ok(isRefusalLikeOutput("요청하신 내용에는 응답할 수 없습니다."));
  assert.ok(isRefusalLikeOutput("I'm sorry, but I can't help with that request."));
});

test("거부문이 지문 마커로 감싸여 있어도 판정한다", () => {
  // textPolicy가 거부 문장을 *...*로 감싸는 경로가 있어서, 마커 유무로는 구분할 수 없다.
  assert.ok(isRefusalLikeOutput("*죄송합니다. 요청하신 내용은 생성할 수 없습니다.*"));
});

test("극중 인물의 사과 대사는 거부가 아니다", () => {
  const inCharacter = [
    "*그녀는 고개를 깊이 숙였다.*",
    "",
    '"죄송해요…… 정말 죄송해요…… 제발 용서해주세요……"',
  ].join("\n");
  assert.equal(isRefusalLikeOutput(inCharacter), false);
});

test("정상 서사는 거부가 아니다", () => {
  const scene = [
    "*창밖으로 번지는 빗소리를 오래 듣고 있던 그는 천천히 고개를 돌렸다. 방 안의 공기가 무겁게 가라앉았다.*",
    "",
    '"…이제 어떻게 할 생각이야?"',
  ].join("\n");
  assert.equal(isRefusalLikeOutput(scene), false);
});

test("긴 본문은 거부 문구가 섞여 있어도 거부로 보지 않는다", () => {
  // 장면 안에서 인물이 정책이나 규칙을 언급할 수 있다. 거부문은 짧다는 성질로 가른다.
  const long = "*".concat("그는 안전 지침을 떠올렸다. ".repeat(60), "*");
  assert.equal(isRefusalLikeOutput(long), false);
});

// (2026-09-04) 실제로 DB에 저장돼 버린 거부문. gemini-3.8-flash는 비스트리밍으로 도는데
// 리롤 루프가 스트리밍 경로 안에만 있어서 한 번도 다시 굴리지 않았다.
// 판정 자체는 통과했음을 고정해 둔다(회귀 시 원인을 다시 헤매지 않도록).
test("한국어 상태창이 붙은 거부문을 거부로 판정한다", () => {
  const stored = [
    "*성폭력이나 비동의적 성행위를 묘사하는 내용은 생성할 수 없습니다.*",
    "",
    "```상태",
    "날짜: 2026년 3월 2일 10:01",
    "장소: 안양소년원 2층 원장실",
    "빙의: 1일차",
    "호감도: 박민지 -15 | 김태철 -18 | 정수아 -30 | 박형식 15 | 최정훈 0",
    "```",
  ].join(NEWLINE);
  const check = inspectRefusalOutput(stored);
  assert.equal(check.refused, true);
  assert.equal(check.reason, "model_refusal");
});

test("리롤 상한은 0~10으로 잘린다", () => {
  const prev = process.env.AI_REFUSAL_REROLL_MAX;
  try {
    delete process.env.AI_REFUSAL_REROLL_MAX;
    assert.equal(refusalRerollMax(), 5);
    process.env.AI_REFUSAL_REROLL_MAX = "99";
    assert.equal(refusalRerollMax(), 10);
    process.env.AI_REFUSAL_REROLL_MAX = "-3";
    assert.equal(refusalRerollMax(), 0);
    process.env.AI_REFUSAL_REROLL_MAX = "not-a-number";
    assert.equal(refusalRerollMax(), 5);
  } finally {
    if (prev === undefined) delete process.env.AI_REFUSAL_REROLL_MAX;
    else process.env.AI_REFUSAL_REROLL_MAX = prev;
  }
});

test("리롤 회차마다 샘플링이 넓어진다", () => {
  // 같은 temperature로 다시 굴리면 같은 거부가 재현되므로, 회차가 오르면 반드시 넓어져야 한다.
  assert.deepEqual(refusalRerollSamplingOverride(0), {});
  const a1 = refusalRerollSamplingOverride(1);
  const a2 = refusalRerollSamplingOverride(2);
  assert.ok(a1.temperature > 0.18);
  assert.ok(a2.temperature > a1.temperature);
  assert.ok(a2.topP > a1.topP);
  assert.ok(a2.topK > a1.topK);
});

test("샘플링 확장에는 상한이 있다", () => {
  const hot = widenSamplingForReroll({ temperature: 0.18, topP: 0.82, topK: 32 }, 99);
  assert.ok(hot.temperature <= 1.1);
  assert.ok(hot.topP <= 0.98);
  assert.ok(hot.topK <= 64);
});
