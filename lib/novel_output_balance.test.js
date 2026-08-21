const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const source = fs.readFileSync("lib/novel_output_balance.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleObj = { exports: {} };
new Function("require", "module", "exports", js)(require, moduleObj, moduleObj.exports);
const { normalizeNovelParagraphMarkers, repairUnbalancedNovelBodyMarkers } = moduleObj.exports;

assert.equal(repairUnbalancedNovelBodyMarkers('"열린 대사\n\n```STATUS\n상태\n```').text, '"열린 대사"\n\n```STATUS\n상태\n```');
assert.equal(repairUnbalancedNovelBodyMarkers('*열린 지문').text, '*열린 지문*');
assert.equal(repairUnbalancedNovelBodyMarkers('"완결 대사"').repaired, false);
assert.equal(
  normalizeNovelParagraphMarkers('평범한 지문입니다.\n\n"대사입니다."\n\n```STATUS\n장소: 방\n```').text,
  '*평범한 지문입니다.*\n\n"대사입니다."\n\n```STATUS\n장소: 방\n```'
);
assert.equal(normalizeNovelParagraphMarkers('*이미 지문*\n\n"이미 대사"').changed, false);
assert.equal(
  normalizeNovelParagraphMarkers('https://example.com/image.webp\n\n다음 지문').text,
  'https://example.com/image.webp\n\n*다음 지문*'
);
assert.equal(normalizeNovelParagraphMarkers('!!https://example.com/image.webp').changed, false);
console.log("novel_output_balance tests passed");
