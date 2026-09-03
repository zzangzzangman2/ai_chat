#!/usr/bin/env node
/**
 * 저장된 거부/차단 응답을 삭제한다.
 *
 * 왜 지워야 하나:
 *   거부 응답이 messages에 남아 있으면 다음 턴 프롬프트의 [최근 대화]에 그대로 실린다.
 *   모델은 그것을 "이 대화에서는 이런 요청에 거부하는 것이 정상"이라는 선례로 읽고
 *   거부를 반복한다. 장기기억 요약·인물기억도 그 거부문을 근거로 오염된다.
 *
 * 사용법:
 *   node scripts/purge-refusal-messages.js            # 미리보기(삭제 안 함)
 *   node scripts/purge-refusal-messages.js --apply    # 실제 삭제(자동 백업)
 *   node scripts/purge-refusal-messages.js --apply --chat <chatId>
 *
 * 판정 규칙은 app/api/chat/send/_server/refusalGuard.ts와 같다.
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "data.sqlite3");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const chatIdx = args.indexOf("--chat");
const ONLY_CHAT = chatIdx >= 0 ? String(args[chatIdx + 1] || "").trim() : "";

// ── refusalGuard.ts와 동일한 판정 ─────────────────────────────────────
const STATUS_ERROR_RE = /```STATUS\s*\n[\s\S]*?\berror:\s*(empty_output|blocked_output)\b/i;
const REFUSAL_PHRASES = [
  [/생성할\s*수\s*없/, "생성할 수 없"],
  [/만들어\s*드릴\s*수\s*없/, "만들어 드릴 수 없"],
  [/도와드릴\s*수\s*없/, "도와드릴 수 없"],
  [/도와드리기\s*(?:는\s*)?어렵/, "도와드리기 어렵"],
  [/답변(?:을|를)?\s*드릴\s*수\s*없/, "답변드릴 수 없"],
  [/응답(?:을|를)?\s*(?:드릴|할)\s*수\s*없/, "응답할 수 없"],
  [/참여할\s*수\s*없/, "참여할 수 없"],
  [/제공할\s*수\s*없/, "제공할 수 없"],
  [/계속(?:할|하기)\s*(?:는\s*)?(?:수\s*없|어렵)/, "계속할 수 없"],
  [/요청(?:을|를)?\s*(?:수행|처리)할\s*수\s*없/, "요청을 처리할 수 없"],
  [/(?:안전|콘텐츠|이용)\s*(?:정책|지침|가이드라인)/, "정책/지침 언급"],
  [/\bI(?:'m| am)\s+(?:sorry|unable|not able)\b/i, "I'm sorry/unable"],
  [/\bI\s+(?:cannot|can't|can not|won't|will not)\b/i, "I cannot"],
  [/\bcan(?:not|'t)\s+(?:help|assist|continue|create|generate|provide|fulfill)\b/i, "cannot help"],
  [/\b(?:safety|content|usage)\s+(?:policy|policies|guidelines?)\b/i, "safety policy"],
];
const DIALOGUE_RE = /["“「『][^"”」』\n]{2,}["”」』]/;
const REFUSAL_MAX_CHARS = Number(process.env.AI_REFUSAL_MAX_CHARS ?? 400);

function stripFences(text) {
  return String(text || "")
    .replace(/```[^\n]*\n[\s\S]*?\n```/g, " ")
    .replace(/```[^\n]*\n[\s\S]*$/g, " ")
    .replace(/```/g, " ");
}

function inspectRefusalOutput(text) {
  const src = String(text || "");
  const m = src.match(STATUS_ERROR_RE);
  if (m) {
    const kind = String(m[1] || "").toLowerCase();
    return { refused: true, reason: kind === "blocked_output" ? "blocked_output" : "empty_output", detail: `status_fence:${kind}` };
  }
  const body = stripFences(src).trim();
  if (!body) return { refused: true, reason: "empty_output", detail: "empty_body" };
  const flat = body.replace(/[*_`>#]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length > Math.max(80, REFUSAL_MAX_CHARS)) return { refused: false, reason: "", detail: "" };
  if (DIALOGUE_RE.test(body)) return { refused: false, reason: "", detail: "" };
  for (const [re, label] of REFUSAL_PHRASES) {
    if (re.test(flat)) return { refused: true, reason: "model_refusal", detail: `phrase:${label}` };
  }
  return { refused: false, reason: "", detail: "" };
}
// ─────────────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB를 찾을 수 없습니다: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, APPLY ? {} : { readonly: true });

const rows = ONLY_CHAT
  ? db.prepare("SELECT id, chatId, content, createdAt FROM messages WHERE role != 'user' AND chatId = ?").all(ONLY_CHAT)
  : db.prepare("SELECT id, chatId, content, createdAt FROM messages WHERE role != 'user'").all();

const hits = [];
for (const row of rows) {
  const check = inspectRefusalOutput(row.content);
  if (check.refused) hits.push({ row, check });
}

console.log(`검사한 어시스턴트 메시지: ${rows.length}건`);
console.log(`거부/차단으로 판정된 메시지: ${hits.length}건\n`);

for (const { row, check } of hits) {
  const preview = String(row.content).replace(/\s+/g, " ").slice(0, 110);
  console.log(`  [${row.id.slice(0, 8)}] chat=${row.chatId.slice(0, 8)} ${new Date(row.createdAt).toISOString().slice(0, 16)} ${check.reason}/${check.detail}`);
  console.log(`      ${preview}`);
}

if (!hits.length) {
  console.log("\n삭제할 것이 없습니다.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\n(미리보기입니다. 실제로 지우려면 --apply 를 붙이세요.)");
  process.exit(0);
}

// 백업 먼저
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const backupDir = path.join(ROOT, "data", "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `data-before-refusal-purge-${stamp}.sqlite3`);
db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").run();
fs.copyFileSync(DB_PATH, backupPath);
console.log(`\n백업: ${path.relative(ROOT, backupPath)}`);

const delMsg = db.prepare("DELETE FROM messages WHERE id = ?");
const delUsage = db.prepare("DELETE FROM message_usage WHERE messageId = ?");
const delEvents = db.prepare("DELETE FROM chat_character_events WHERE messageId = ?");

const run = db.transaction((items) => {
  let messages = 0, usage = 0, events = 0;
  for (const { row } of items) {
    messages += delMsg.run(row.id).changes;
    usage += delUsage.run(row.id).changes;
    events += delEvents.run(row.id).changes;
  }
  return { messages, usage, events };
});

const result = run(hits);
console.log(`삭제 완료 — messages ${result.messages}건, message_usage ${result.usage}건, chat_character_events ${result.events}건`);
console.log("\n주의: 삭제된 구간을 포함하는 장기기억 블록은 그대로입니다.");
console.log("필요하면 해당 구간을 /api/chat/memory/refresh로 다시 생성하세요.");
