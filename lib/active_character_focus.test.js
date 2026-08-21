const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

function loadModule(path) {
  const source = fs.readFileSync(path, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", js)(require, module, module.exports);
  return module.exports;
}

const { resolveActiveCharacterFocus, usesSecondPersonReference } = loadModule("lib/active_character_focus.ts");
const identities = [
  { id: "jia", name: "박지아", aliases: '["지아"]' },
  { id: "jieun", name: "유지은", aliases: '["지은"]' },
];

assert.equal(resolveActiveCharacterFocus({ identities, currentUserText: "지아야, 이리 와" }).names[0], "박지아");
assert.deepEqual(
  resolveActiveCharacterFocus({
    identities,
    currentUserText: "너한테 물어보는 거야",
    previousUserTexts: ["그래, 계속해", "지아야, 이리 와", "지은은 어디 있어?"],
  }).names,
  ["박지아"]
);
assert.equal(usesSecondPersonReference("너무 늦었어"), false);
assert.equal(usesSecondPersonReference("넌 왜 그래?"), true);
console.log("active_character_focus tests passed");
