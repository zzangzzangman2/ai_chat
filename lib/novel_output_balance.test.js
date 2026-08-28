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
  repairUnbalancedNovelBodyMarkers(
    '*성준의 눈앞에서 시스템 창이 깜빡였다.\n`[경고: 대상과의 신뢰도가 최하치로 추락했습니다*'
  ).text,
  '*성준의 눈앞에서 시스템 창이 깜빡였다.\n`[경고: 대상과의 신뢰도가 최하치로 추락했습니다]`*'
);
assert.equal(
  repairUnbalancedNovelBodyMarkers('*시스템이 `[알림]`을 표시했다.*').repaired,
  false
);
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
assert.equal(
  normalizeNovelParagraphMarkers(
    '*검사가 서류를 펼쳤다.*\n\n"공소사실을 낭독하겠습니다.\n\n*방청석이 조용해졌다.*\n\n*피고인은 범행을 반복했습니다."*\n\n*재판장이 굳었다.**'
  ).text,
  '*검사가 서류를 펼쳤다.*\n\n"공소사실을 낭독하겠습니다."\n\n*방청석이 조용해졌다.*\n\n"피고인은 범행을 반복했습니다."\n\n*재판장이 굳었다.*'
);
assert.equal(
  normalizeNovelParagraphMarkers('*끔찍한 적나라함이었다. \n\n*피해 사실을 유포했습니다."*').text,
  '*끔찍한 적나라함이었다.*\n\n"피해 사실을 유포했습니다."'
);
assert.equal(
  normalizeNovelParagraphMarkers('*방금 그건 무슨 태도입니까?"*').text,
  '"방금 그건 무슨 태도입니까?"'
);
assert.equal(
  normalizeNovelParagraphMarkers('*강동철은 기기를 내려놓았다.*"').text,
  '*강동철은 기기를 내려놓았다.*'
);
assert.equal(
  normalizeNovelParagraphMarkers('*쾅!* 굳게 잠긴 문이 열렸다.').text,
  '*쾅! 굳게 잠긴 문이 열렸다.*'
);
assert.equal(
  normalizeNovelParagraphMarkers('"완결 대사""').text,
  '"완결 대사"'
);
const paragraphBalanced = normalizeNovelParagraphMarkers(
  '*지문*\n\n"대사"\n\n*다음 지문*'
).text;
assert.equal(normalizeNovelParagraphMarkers(paragraphBalanced).text, paragraphBalanced);
assert.equal(
  normalizeNovelParagraphMarkers('"대사입니다."```상태\n장소: 방\n```').text,
  '"대사입니다."\n\n```상태\n장소: 방\n```'
);
console.log("novel_output_balance tests passed");
