const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("lib/canonical_fact_resolution.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const { resolveCanonicalFactCandidate } = moduleObj.exports;

assert.equal(resolveCanonicalFactCandidate([{ sourceRole: "assistant", value: "22세", turnNo: 3 }]), null);
assert.equal(
  resolveCanonicalFactCandidate([
    { sourceRole: "assistant", value: "22세", turnNo: 3 },
    { sourceRole: "assistant", value: "22세", turnNo: 5 },
  ]).value,
  "22세"
);
assert.equal(
  resolveCanonicalFactCandidate([
    { sourceRole: "assistant", value: "22세", turnNo: 3 },
    { sourceRole: "assistant", value: "22세", turnNo: 5 },
    { sourceRole: "user", value: "14세", turnNo: 7 },
  ]).value,
  "14세"
);
console.log("canonical_fact_resolution tests passed");
