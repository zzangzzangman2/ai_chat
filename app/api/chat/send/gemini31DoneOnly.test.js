const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const route = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");

test("Gemini 3.1 Pro always uses completed-response generation", () => {
  assert.match(route, /const isGemini31Pro = isGemini31ProModel\(modelName\)/);
  assert.match(route, /const G3PRO_DONE_ONLY = isGemini31Pro/);
  assert.match(route, /const PRO_DONE_ONLY = isGemini31Pro/);
  assert.doesNotMatch(route, /AI_G3PRO_DONE_ONLY/);
});
