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
    { sourceRole: "assistant", value: "22세", turnNo: 3, evidence: "첫 장면에서 스물두 살이라고 소개했다" },
    { sourceRole: "assistant", value: "22세", turnNo: 5, evidence: "신분증의 나이는 스물두 살이었다" },
  ]).value,
  "22세"
);
assert.equal(
  resolveCanonicalFactCandidate([
    { sourceRole: "assistant", value: "22세", turnNo: 3, evidence: "같은 원문 근거" },
    { sourceRole: "assistant", value: "22세", turnNo: 5, evidence: "같은 원문 근거" },
  ]),
  null
);
assert.equal(
  resolveCanonicalFactCandidate([
    { sourceRole: "assistant", value: "22세", turnNo: 3, evidence: "첫 근거" },
    { sourceRole: "assistant", value: "22세", turnNo: 5, evidence: "둘째 근거" },
    { sourceRole: "user", value: "14세", turnNo: 7 },
  ]).value,
  "14세"
);
console.log("canonical_fact_resolution tests passed");
