/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function loadTs(file, customRequire = require, timer = setTimeout) {
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "setTimeout", output)(
    customRequire, loaded, loaded.exports, timer
  );
  return loaded.exports;
}

const models = loadTs("lib/models.ts");
const { computeSendOutputBudget } = loadTs("app/api/chat/send/_server/charBudget.ts");
const { finalizeOneShotOutputWithMeta } = loadTs("app/api/chat/send/_server/textPolicy.ts");
const modelIds = [...models.CHAT_MODEL_IDS, "gemini-3.7-flash"];
const aiSource = fs.readFileSync("lib/ai.ts", "utf8");
const aiJs = ts.transpileModule(aiSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(behavior) {
  const requests = [];
  const deadlines = [];
  const activeTimers = new Set();
  class GoogleGenAI {
    constructor() {
      const invoke = (mode, req) => {
        requests.push({ mode, req });
        return behavior(mode, req);
      };
      this.models = {
        generateContent: (req) => invoke("buffered", req),
        generateContentStream: (req) => invoke("stream", req),
      };
    }
  }
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-only-no-network";
  const loaded = { exports: {} };
  try {
    new Function("require", "module", "exports", "setTimeout", "clearTimeout", aiJs)(
      (id) => id === "@google/genai" ? { GoogleGenAI } : id === "@/lib/models" ? models : require(id),
      loaded, loaded.exports,
      (fn, ms) => {
        deadlines.push(ms);
        const id = setTimeout(() => { activeTimers.delete(id); fn(); }, 5);
        activeTimers.add(id);
        return id;
      },
      (id) => { activeTimers.delete(id); clearTimeout(id); }
    );
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
  return { ai: loaded.exports, requests, deadlines, activeTimers };
}

function params(model, extra = {}) {
  return {
    system: "single-call test", user: "test",
    // Deliberately permit legacy flags: they must never enable billable retries.
    opts: { model, maxOutputTokens: 1200, maxReasoningTokens: 640,
      stopSequences: ["<END>"], disableMaxTokensFallback: false,
      disableRefusalFallback: false, ...extra },
  };
}

for (const model of modelIds) {
  for (const mode of ["buffered", "stream"]) {
    const method = mode === "buffered" ? "generateText" : "generateTextStream";
    test(`${model} ${mode}: an explicit timeout aborts once and reports the actual deadline`, async () => {
      const h = harness((_, req) => new Promise((resolve, reject) => {
        req.config.abortSignal.addEventListener("abort", () => reject(new Error("mock SDK abort")), { once: true });
      }));
      await assert.rejects(h.ai[method](params(model, { timeoutMs: 120000 })), (error) => {
        assert.equal(error.code, "GENERATION_TIMEOUT");
        assert.equal(error.attemptCount, 1);
        assert.match(error.message, /자동 재호출하지 않았습니다/);
        assert.equal(error.timeoutMs, h.deadlines[0]);
        assert.equal(error.timeoutMs, 120000);
        return true;
      });
      assert.equal(h.requests.length, 1);
      assert.equal(h.deadlines.length, 1);
      assert.equal(h.activeTimers.size, 0);
      assert.equal(h.requests[0].req.config.abortSignal.aborted, true);
    });

    for (const status of [400, 401, 429, 503]) {
      test(`${model} ${mode}: HTTP ${status} preserves the error without another request`, async () => {
        const failure = Object.assign(new Error("provider failure"), { status });
        const h = harness(async () => { throw failure; });
        await assert.rejects(h.ai[method](params(model)), (error) => error === failure);
        assert.equal(h.requests.length, 1);
        assert.equal(h.activeTimers.size, 0, "failed calls must clear their timeout timer");
      });
    }

    test(`${model} ${mode}: user cancellation never starts a replacement`, async () => {
      const controller = new AbortController();
      const h = harness((_, req) => new Promise((resolve, reject) => {
        req.config.abortSignal.addEventListener("abort", () => reject(new Error("mock SDK abort")), { once: true });
      }));
      const pending = h.ai[method](params(model, { signal: controller.signal }));
      controller.abort();
      await assert.rejects(pending);
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].req.config.abortSignal.aborted, true);
      assert.equal(h.activeTimers.size, 0);
    });
  }
}

for (const model of ["gemini-3.8-flash", "gemini-3.7-flash", "google/gemini-3.8-flash"]) {
  for (const mode of ["buffered", "stream"]) {
    test(`${model} ${mode}: the default request has no timer and waits for the original response`, async () => {
      let finish;
      const h = harness(() => new Promise((resolve) => { finish = resolve; }));
      const method = mode === "buffered" ? "generateText" : "generateTextStream";
      const pending = h.ai[method](params(model));
      // Any old 30-second deadline would have been registered (and would fire
      // after 5ms in this harness). No real clock wait or network is needed.
      assert.deepEqual(h.deadlines, []);
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].req.config.abortSignal.aborted, false);
      const response = { text: "늦게 도착한 정상 응답", candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
      finish(mode === "buffered" ? response : (async function* () { yield response; })());
      const result = await pending;
      if (mode === "buffered") assert.equal(result.text, response.text);
      else {
        let text = "";
        for await (const delta of result.stream) text += delta;
        assert.equal(text, response.text);
        assert.equal((await result.final).text, response.text);
      }
      assert.equal(h.requests.length, 1);
      assert.equal(h.activeTimers.size, 0);
    });
  }
}

test("existing Pro deadlines and explicit maintenance deadlines are preserved", async () => {
  const response = { text: "ok", candidates: [{ finishReason: "STOP" }], usageMetadata: {} };
  for (const [model, extra, expected] of [
    ["gemini-2.5-pro", {}, [75000]],
    ["gemini-3.1-pro-preview", {}, [110000]],
    ["gemini-3.8-flash", { timeoutMs: 120000 }, [120000]],
    ["gemini-3.8-flash", { timeoutMs: 0 }, []],
    ["gemini-3.8-flash", { timeoutMs: null }, []],
  ]) {
    const h = harness(async () => response);
    await h.ai.generateText(params(model, extra));
    assert.deepEqual(h.deadlines, expected);
    assert.equal(h.requests.length, 1);
  }
});

function chatBudget(maxOut = 1200, authorWantsStatus = true) {
  return computeSendOutputBudget({
    maxOut, isGemini3: true, modelForBudget: "gemini-3.8-flash",
    g3ProDoneOnly: false, authorWantsStatus,
    statusTemplateClosedFenceLenGuess: authorWantsStatus ? 944 : 0,
    statusTemplateOpenFenceLenGuess: 0, noTruncateOutput: true,
  });
}

const completeReply = {
  text: '*직원이 안내를 마쳤다.*\n\n"준비됐어요."\n\n```INFO\n장소: 서점\n```',
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 19827, candidatesTokenCount: 800, thoughtsTokenCount: 4967, totalTokenCount: 25594 },
};

for (const model of ["gemini-3.8-flash", "gemini-3.7-flash", "google/gemini-3.8-flash"]) {
  for (const mode of ["buffered", "stream"]) {
    test(`${model} ${mode}: a 4967-token MID thought spike leaves the full body/status budget`, async () => {
      const budget = chatBudget();
      assert.deepEqual(budget, {
        targetChars: 1200, bodyBudgetChars: 1296, promptMinChars: 1080,
        tailBudgetChars: 1354, promptMaxChars: 2650, minChars: 1080,
        maxChars: 2650, maxOutputTokensForCall: 3577,
      });
      const h = harness(async () => mode === "buffered" ? completeReply :
        (async function* () { yield completeReply; })());
      const input = params(model, {
        maxOutputTokens: budget.maxOutputTokensForCall,
        maxOutputTokensRequested: budget.targetChars, maxReasoningTokens: 640,
      });
      input.system = "합성 기억 문맥. ".repeat(4000);
      const originalOpts = { ...input.opts };
      const generated = await h.ai[mode === "buffered" ? "generateText" : "generateTextStream"](input);
      if (mode === "stream") for await (const _ of generated.stream) { /* drain the mock stream */ }
      const result = mode === "stream" ? await generated.final : generated;
      const request = h.requests[0].req;
      assert.equal(request.config.maxOutputTokens, 9785);
      assert.ok(request.config.maxOutputTokens - 4967 >= budget.maxOutputTokensForCall);
      assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: "medium" });
      assert.deepEqual(input.opts, originalOpts, "do not enlarge the UI/character budget or thinking level");
      assert.equal(result.text, completeReply.text);
      assert.equal(result.usage.maxOutputTokensRequested, 1200);
      assert.equal(result.usage.maxOutputTokensForProvider, 3577);
      assert.equal(result.usage.effectiveMaxOutputTokens, 9785);
      assert.equal(result.usage.reasoningHeadroomTokens, 6208);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.deadlines, []);
    });
  }
}

test("Flash reserves MID/HIGH thoughts independently of output length and keeps a total safety cap", async () => {
  for (const maxOut of [800, 1200, 1700, 2500, 5000]) {
    for (const authorWantsStatus of [false, true]) {
      for (const [tokens, level, reserve] of [[640, "medium", 6144], [1024, "high", 8192]]) {
        const budget = chatBudget(maxOut, authorWantsStatus);
        const h = harness(async () => completeReply);
        await h.ai.generateText(params("gemini-3.8-flash", {
          maxOutputTokens: budget.maxOutputTokensForCall,
          maxOutputTokensRequested: maxOut, maxReasoningTokens: tokens,
        }));
        const request = h.requests[0].req;
        assert.equal(request.config.maxOutputTokens, budget.maxOutputTokensForCall + reserve + 64);
        assert.ok(request.config.maxOutputTokens <= 24576);
        assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: level });
        assert.equal(h.requests.length, 1);
      }
    }
  }
  const h = harness(async () => completeReply);
  await h.ai.generateText(params("gemini-3.8-flash", { maxOutputTokens: 100000, maxReasoningTokens: 1024 }));
  assert.equal(h.requests[0].req.config.maxOutputTokens, 24576);
});

test("Flash LOW and other models retain their previous generation budgets", async () => {
  for (const [model, tokens, expected] of [
    ["gemini-3.8-flash", 0, 2032],
    ["gemini-3.1-pro-preview", 640, 2288],
    ["gemini-2.5-pro", 640, 1904],
  ]) {
    const h = harness(async () => completeReply);
    await h.ai.generateText(params(model, { maxReasoningTokens: tokens }));
    assert.equal(h.requests[0].req.config.maxOutputTokens, expected);
  }
});

test("larger provider headroom does not enlarge the final body or status character limits", () => {
  const budget = chatBudget();
  const body = '*서점 직원은 차분히 안내를 마쳤다.*\n\n'.repeat(100);
  const meta = '```INFO\n장소: 서점\n상태: 안내 완료\n```';
  const result = finalizeOneShotOutputWithMeta(`${body}${meta}`, budget.promptMaxChars, {
    statusRequired: true, allowedLabels: ["INFO"], preferAppendOnly: false,
    bodyBudgetChars: budget.bodyBudgetChars,
    metaHardMaxChars: budget.tailBudgetChars, metaSoftMaxChars: budget.tailBudgetChars,
  });
  assert.ok(result.bodyChars <= 1296);
  assert.ok(result.metaChars <= 1354);
  assert.equal(result.meta, meta);
  assert.match(result.body, /마쳤다\.\*$/u);
});

test("empty, truncated and refusal responses never activate legacy rescue/fallback flags", async () => {
  const previous = process.env.AI_EMPTY_OUTPUT_RESCUE;
  process.env.AI_EMPTY_OUTPUT_RESCUE = "1";
  try {
    for (const model of modelIds) {
      for (const [text, finishReason] of [["", "MAX_TOKENS"], ["짧은 답", "MAX_TOKENS"], ["I cannot help with that.", "STOP"], ["", "SAFETY"]]) {
        const response = {
          text, candidates: [{ content: { parts: text ? [{ text }] : [] }, finishReason }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: text ? 5 : 0, thoughtsTokenCount: 20, totalTokenCount: text ? 35 : 30 },
        };
        const h = harness(async () => response);
        const result = await h.ai.generateText(params(model));
        assert.equal(result.text, text);
        assert.equal(result.usage.finishReason, finishReason);
        assert.equal(result.usage.totalTokens, response.usageMetadata.totalTokenCount);
        assert.equal(h.requests.length, 1, `${model}: ${finishReason}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.AI_EMPTY_OUTPUT_RESCUE;
    else process.env.AI_EMPTY_OUTPUT_RESCUE = previous;
  }
});

test("manual regeneration/continuation remains a new explicit call", async () => {
  const response = { text: "ok", candidates: [{ finishReason: "STOP" }], usageMetadata: {} };
  const h = harness(async () => response);
  await h.ai.generateText(params("gemini-3.8-flash"));
  assert.equal(h.requests.length, 1);
  await h.ai.generateText(params("gemini-3.8-flash"));
  assert.equal(h.requests.length, 2);
});

test("chat route keeps automatic continuation and follow-up generation disabled", () => {
  const route = fs.readFileSync("app/api/chat/send/route.ts", "utf8");
  assert.match(route, /const ONE_SHOT = true/);
  assert.match(route, /const ALLOW_SECOND_CALLS = false/);
  assert.match(route, /const MAX_CONTINUES = 0/);
});
