const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "ChatArea.tsx"), "utf8");

test("novel narration uses the per-chat color instead of hardcoded white", () => {
  assert.match(source, /narration:\s*resolvedNarrationColor/);
  assert.match(source, /const NOVEL_NARRATION = CHAT_THEME\.narration/);
  assert.doesNotMatch(source, /const NOVEL_NARRATION = ["']#ffffff["']/i);
});
