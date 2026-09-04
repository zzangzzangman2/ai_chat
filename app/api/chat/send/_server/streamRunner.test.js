const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const guardModule = { exports: {} };
Function("exports", "module", "require", transpile("lib/turn_completion_guard.ts"))(
  guardModule.exports,
  guardModule,
  require
);
const refusalGuardModule = { exports: {} };
Function("exports", "module", "require", transpile(path.join(__dirname, "refusalGuard.ts")))(
  refusalGuardModule.exports,
  refusalGuardModule,
  require
);
const runnerModule = { exports: {} };
const localRequire = (id) => {
  if (id.endsWith("lib/turn_completion_guard")) return guardModule.exports;
  // streamRunner는 리롤 샘플링 규칙을 refusalGuard와 공유한다(단일 출처).
  if (id === "./refusalGuard") return refusalGuardModule.exports;
  return require(id);
};
Function("exports", "module", "require", transpile(path.join(__dirname, "streamRunner.ts")))(
  runnerModule.exports,
  runnerModule,
  localRequire
);
const { runOptionalShortContinue } = runnerModule.exports;

const passthroughParams = {
  allowSecondCalls: false,
  oneShot: true,
  disallowG3ProContinue: true,
  promptMinForGuide: 300,
  promptMaxChars: 1200,
  maxOutputTokensForCall: 1200,
  combinedUsage: { finishReason: "STOP", outputTokens: 100 },
  systemForContinuation: "continue",
  opts: { maxReasoningTokens: 768 },
  mergeUsage: (base, add) => ({ ...base, ...add }),
  safeEnqueue: () => {
    throw new Error("bounded recovery must publish a replacement, not a trailing delta");
  },
  stripEndMarker: (value) => String(value || ""),
  stripStandaloneSeparatorLines: (value) => String(value || ""),
  stripUrlsAndMediaMarkdown: (value) => String(value || ""),
  streamDebug: false,
  streamTag: "test",
};

test("short or plural-incomplete STOP remains one-shot", async () => {
  let calls = 0;
  const fence = "```";
  const result = await runOptionalShortContinue({
    ...passthroughParams,
    raw: `*둘은 서로를 바라봤다.*\n\n"저는 혜진이요."${fence}상태\n날짜: 10:07\n${fence}`,
    currentUserText: "너네 학교에서 제일 예쁜 애가 누구야?",
    allowBoundedRecovery: true,
    makeContinueUser: () => "continue",
    generateText: async () => {
      calls += 1;
      return { text: "unexpected", usage: {} };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.replaced, false);
  assert.equal((result.raw.match(/```상태/gu) || []).length, 1);
  assert.doesNotMatch(result.raw, /다른 아이도/u);
});

test("MAX_TOKENS recovery stays inside the original display budget", async () => {
  let calls = 0;
  const result = await runOptionalShortContinue({
    ...passthroughParams,
    oneShot: false,
    raw: "가".repeat(900),
    combinedUsage: { finishReason: "MAX_TOKENS", outputTokens: 300 },
    currentUserText: "계속해",
    promptMaxChars: 1200,
    allowBoundedRecovery: true,
    makeContinueUser: () => "continue",
    generateText: async () => {
      calls += 1;
      return {
        text: "나".repeat(1000),
        usage: { finishReason: "STOP", outputTokens: 400 },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.replaced, true);
  assert.ok(Array.from(result.raw).length <= 1200);
});

test("ONE_SHOT suppresses MAX_TOKENS recovery calls", async () => {
  let calls = 0;
  const result = await runOptionalShortContinue({
    ...passthroughParams,
    raw: "가".repeat(900),
    combinedUsage: { finishReason: "MAX_TOKENS", outputTokens: 300 },
    currentUserText: "계속해",
    allowBoundedRecovery: true,
    makeContinueUser: () => "continue",
    generateText: async () => {
      calls += 1;
      return { text: "unexpected", usage: {} };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.replaced, false);
});

test("complete STOP remains one-shot", async () => {
  let calls = 0;
  const result = await runOptionalShortContinue({
    ...passthroughParams,
    raw: '*둘은 차례로 답했다.*\n\n"첫 답이에요."\n\n"두 번째 답이에요."',
    currentUserText: "둘 다 대답해",
    promptMinForGuide: 20,
    allowBoundedRecovery: true,
    makeContinueUser: () => "continue",
    generateText: async () => {
      calls += 1;
      return { text: "unexpected", usage: {} };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.replaced, false);
});
