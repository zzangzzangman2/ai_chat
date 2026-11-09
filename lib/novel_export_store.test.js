/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
function load(file, imports = {}) {
  const loaded = { exports: {} };
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  new Function("require", "module", "exports", js)((id) => imports[id] || require(id), loaded, loaded.exports);
  return loaded.exports;
}
const storeModule = load("lib/novel_export_store.ts", {
  "@/lib/crypto": load("lib/crypto.ts"), "@/lib/novel_export": load("lib/novel_export.ts"),
});
const input = { ownerEmail: "test@example.invalid", chatId: "chat", author: "작가", sourceMessages: 2,
  chunks: [{ index: 1, startTurn: 1, endTurn: 1, source: "고정된 원문" }, { index: 2, startTurn: 2, endTurn: 2, source: "다음 원문" }] };
function setup(t, codec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arca-novel-store-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("arca-novel-store-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store: storeModule.createNovelExportStore(root, codec) };
}

test("checkpoints survive a fresh store instance and preserve source and chapter metadata", (t) => {
  const { root, store } = setup(t);
  const record = store.create(input);
  record.chapters.push({ index: 1, title: "제 1화 방문", body: "완성된 원고", startTurn: 1, endTurn: 1,
    novelTitle: "문 너머", introduction: "소개", characters: [{ name: "지은", introduction: "주인공" }] });
  store.save(record);
  const loaded = storeModule.createNovelExportStore(root).load(input.ownerEmail, input.chatId, record.id);
  assert.deepEqual(loaded.chunks, input.chunks);
  assert.deepEqual(loaded.chapters, record.chapters);
  assert.match(storeModule.novelExportFilename(loaded), /1-1장\.pdf/u);
  assert.equal(store.load("someone-else", input.chatId, record.id), null);
  assert.throws(() => store.load(input.ownerEmail, input.chatId, "../../other"), /ID/u);
});

test("a failed write leaves the previous checkpoint intact and removes only its temporary file", (t) => {
  let fail = false;
  const { root, store } = setup(t, { encode: (value) => { if (fail) throw new Error("disk failed"); return value; }, decode: (value) => value });
  const record = store.create(input);
  record.chapters.push({ index: 1, title: "제 1화", body: "완성된 원고", startTurn: 1, endTurn: 1 });
  fail = true;
  assert.throws(() => store.save(record), /disk failed/);
  assert.equal(store.load(input.ownerEmail, input.chatId, record.id).chapters.length, 0);
  assert.equal(fs.readdirSync(path.join(root, storeModule.novelExportScope(input.ownerEmail, input.chatId))).length, 1);
});

test("an older generation object preserves newer download timestamps and rejects inconsistent chapter order", (t) => {
  const { store } = setup(t);
  const older = store.create(input);
  const newer = store.load(input.ownerEmail, input.chatId, older.id);
  newer.lastDownloadedAt = 12345;
  store.save(newer);
  store.save(older);
  assert.equal(store.load(input.ownerEmail, input.chatId, older.id).lastDownloadedAt, 12345);
  older.chapters = [{ index: 2, title: "잘못된 순서", body: "원고", startTurn: 2, endTurn: 2 }];
  assert.throws(() => store.save(older), /손상/u);
});
