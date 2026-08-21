const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("lib/novel_output_balance.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const { repairUnbalancedNovelBodyMarkers } = moduleObj.exports;

assert.equal(repairUnbalancedNovelBodyMarkers('"열린 대사\n\n```STATUS\n상태\n```').text, '"열린 대사"\n\n```STATUS\n상태\n```');
assert.equal(repairUnbalancedNovelBodyMarkers('*열린 지문').text, '*열린 지문*');
assert.equal(repairUnbalancedNovelBodyMarkers('"완결 대사"').repaired, false);
console.log("novel_output_balance tests passed");
