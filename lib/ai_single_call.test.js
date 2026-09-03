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
    test(`${model} ${mode}: timeout aborts once and reports the actual deadline`, async () => {
      const h = harness((_, req) => new Promise((resolve, reject) => {
        req.config.abortSignal.addEventListener("abort", () => reject(new Error("mock SDK abort")), { once: true });
      }));
      await assert.rejects(h.ai[method](params(model)), (error) => {
        assert.equal(error.code, "GENERATION_TIMEOUT");
        assert.equal(error.attemptCount, 1);
        assert.match(error.message, /자동 재호출하지 않았습니다/);
        assert.equal(error.timeoutMs, h.deadlines[0]);
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
