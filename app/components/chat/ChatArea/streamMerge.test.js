const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

function transpile(path, customRequire) {
  const source = fs.readFileSync(path, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const moduleObj = { exports: {} };
  new Function("require", "module", "exports", js)(customRequire || require, moduleObj, moduleObj.exports);
  return moduleObj.exports;
}

const textUtils = transpile("app/components/chat/ChatArea/textUtils.ts", (id) => {
  if (id === "@/lib/models") return { isReasoningPresetValue: () => false, reasoningPresetsForModel: () => [] };
  return require(id);
});
const streamMerge = transpile("app/components/chat/ChatArea/streamMerge.ts", (id) => {
  if (id === "./textUtils") return textUtils;
  return require(id);
});

const buffered = '"열린 대사\n\n```상태\n날짜: 22:36\n호감도: 지아 -100\n```';
const server = '"열린 대사"\n\n```상태\n날짜: 22:36\n호감도: 지아 -100 | 수진 -100\n```';
const merged = streamMerge.mergeStreamFinalContent({ buffered, fromServer: server, metaLabels: ["상태"] });
assert.equal(merged.content, server);
assert.equal((merged.content.match(/```상태/g) || []).length, 1);

const malformedLongerBuffer = [
  "*스트리밍 중에만 남은 삭제 대상 문장.*",
  "",
  '또한 이미 제출된 증거만으로도 충분히 소명되었습니다."',
  "",
  "```상태",
  "날짜: 22:36",
  "```",
].join("\n");
const authoritativeServer = [
  '"또한 이미 제출된 증거만으로도 충분히 소명되었습니다."',
  "",
  "```상태",
  "날짜: 22:36",
  "```",
].join("\n");
const authoritative = streamMerge.mergeStreamFinalContent({
  buffered: malformedLongerBuffer,
  fromServer: authoritativeServer,
  metaLabels: ["상태"],
});
assert.equal(authoritative.content, authoritativeServer);
assert.equal(authoritative.source, "server");
console.log("streamMerge tests passed");
