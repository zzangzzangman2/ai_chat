#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readlineCore = require("readline");
const readline = require("readline/promises");

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(ROOT, "data", "data.sqlite3");
const ENC_PREFIX = "enc:v1:";
const MODELS = ["gemini-2.5-pro", "gemini-3.6-flash", "gemini-3.1-pro-preview"];
const MODEL_OPTIONS = [
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
];

// ────────────────────────────────────────────────────────────────────
// LOW / MID / HIGH 3단계 프리셋 (웹 UI textUtils.ts와 동일한 값)
// 출력길이는 모델 무관, 추론은 모델별로 다르게.
// ────────────────────────────────────────────────────────────────────
const OUTPUT_PRESETS = { low: 1200, middle: 1700, high: 2500 };
const LEVEL_LABEL = { zero: "ZERO", low: "LOW", middle: "MID", high: "HIGH" };
const LEVEL_ALIASES = {
  zero: "zero", off: "zero", fast: "zero", z: "zero", f: "zero", 0: "zero",
  low: "low", l: "low",
  middle: "middle", mid: "middle", m: "middle",
  high: "high", h: "high",
};

function isGemini3ProFamilyModel(model) {
  return /gemini-3(?:\.\d+)?-pro/i.test(String(model || ""));
}
function isGemini3FlashModel(model) {
  return /^gemini-3(?:\.\d+)?-flash(?:-|$)/i.test(String(model || ""));
}
function getReasoningPresets(model) {
  if (isGemini3ProFamilyModel(model)) return { zero: 0, middle: 768, high: 1536 };
  // Gemini 3.6 Flash supports medium/high thinking levels, not zero/minimal.
  if (/^gemini-3\.6-flash(?:-|$)/i.test(String(model || ""))) return { middle: 640, high: 1024 };
  if (isGemini3FlashModel(model))     return { low: 0, middle: 640, high: 1024 };
  return { low: 384, middle: 768, high: 2048 }; // gemini-2.5-pro 등
}

function reasoningTokensForModelChange(currentModel, nextModel, currentTokens) {
  const currentPresets = getReasoningPresets(currentModel);
  const nextPresets = getReasoningPresets(nextModel);
  let level = inferLevel(currentPresets, currentTokens);
  if (!Object.prototype.hasOwnProperty.call(nextPresets, level)) {
    level = Object.prototype.hasOwnProperty.call(nextPresets, "middle") ? "middle" : Object.keys(nextPresets)[0];
  }
  return nextPresets[level] ?? Object.values(nextPresets)[0];
}
function reasoningLevelLabel(model, level) {
  return level === "zero" && isGemini3ProFamilyModel(model) ? "FAST" : LEVEL_LABEL[level];
}
function inferLevel(presets, tokens) {
  const t = Number(tokens) || 0;
  let best = "low";
  let bestDist = Infinity;
  for (const k of Object.keys(presets)) {
    const d = Math.abs(presets[k] - t);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best;
}
function parseLevelArg(arg, allowZero = false) {
  const s = String(arg || "").trim().toLowerCase();
  if (!s) return null;
  const level = LEVEL_ALIASES[s] || null;
  return level === "zero" && !allowZero ? null : level;
}

loadEnv(path.join(ROOT, ".env"), false);
loadEnv(path.join(ROOT, ".env.local"), true);

// dev 서버(LOCAL_AUTH)와 동일한 기본 사용자.
// dos는 같은 SQLite를 직접 읽으므로, 다른 계정의 채팅이 목록/검색에 섞이지 않도록 필터에 사용한다.
const LOCAL_USER_EMAIL = (
  process.env.LOCAL_USER_EMAIL ||
  "godhotyes@gmail.com"
).trim().toLowerCase();

let Database;
try {
  Database = require("better-sqlite3");
} catch (err) {
  console.error("SQLite 모듈을 불러오지 못했습니다.");
  console.error("이 파일을 직접 실행하지 말고 run-dos.ps1로 실행해 주세요.");
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || readPortFile() || 3000);
const API_BASE = `http://127.0.0.1:${PORT}`;
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[38;5;244m",
  narration: "\x1b[38;5;242m",
  dialogue: "\x1b[38;5;250m",
  meta: "\x1b[38;5;247m",
  soft: "\x1b[38;5;248m",
  title: "\x1b[38;5;252m",
  accent: "\x1b[38;5;250m",
  green: "\x1b[38;5;249m",
  yellow: "\x1b[38;5;251m",
  red: "\x1b[38;5;247m",
  reverse: "\x1b[7m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  mouseOn: "\x1b[?1000h\x1b[?1006h",
  mouseOff: "\x1b[?1000l\x1b[?1006l",
  alternateOn: "\x1b[?1049h",
  alternateOff: "\x1b[?1049l",
};

const state = {
  chatId: String(args.chat || args.chatId || "").trim(),
  recentChats: [],
  recentPresets: [],
  settings: null,
  lastTiming: null,
  // 현재 진행 중인 요청의 AbortController. Ctrl+C 시 abort()해서 진행 중지하고 prompt로 복귀한다.
  activeController: null,
  // readline prompt 대기 중 Ctrl+C / Ctrl+Z를 명령으로 처리하기 위한 컨트롤러.
  promptController: null,
  shortcutAction: "",
};

function restoreTerminal() {
  try {
    process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.reset}${ANSI.alternateOff}`);
  } catch {}
  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {}
}

process.on("exit", restoreTerminal);
process.on("uncaughtException", (err) => {
  restoreTerminal();
  console.error(`오류: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  restoreTerminal();
  console.error(`오류: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

function abortActiveRequest() {
  if (state.activeController) {
    try { state.activeController.abort(); } catch {}
    state.activeController = null;
    process.stdout.write("\n[요청 취소됨 — 새로 입력하세요]\n");
    return true;
  }
  return false;
}

function requestPromptShortcut(action) {
  if (abortActiveRequest()) return;
  if (!state.promptController) return;
  if (!state.shortcutAction) state.shortcutAction = action;
  try { state.promptController.abort(); } catch {}
}

// Ctrl+C 처리:
// - 진행 중인 요청이 있으면 → abort
// - 입력 대기 중이면 → 이전 화면으로 이동
process.on("SIGINT", () => {
  if (abortActiveRequest()) return;
  if (state.promptController) {
    requestPromptShortcut("back");
  } else {
    process.stdout.write("\nCtrl+C: 이전 화면으로 이동할 입력 대기 상태가 아닙니다. 종료는 /exit\n");
  }
});

function installPromptShortcuts(rl) {
  try {
    rl.on("SIGINT", () => requestPromptShortcut("back"));
    rl.on("SIGTSTP", () => requestPromptShortcut("delete"));
  } catch {}

  if (!process.stdin.isTTY) return;
  try {
    readlineCore.emitKeypressEvents(process.stdin, rl);
  } catch {
    return;
  }

  const onKeypress = (str, key) => {
    const isCtrlZ = (key && key.ctrl && key.name === "z") || str === "\x1a";
    const isCtrlC = key && key.ctrl && key.name === "c";
    if (state.activeController && (isCtrlZ || isCtrlC)) {
      abortActiveRequest();
      return;
    }
    if (!state.promptController) return;
    if (isCtrlZ) {
      requestPromptShortcut("delete");
    } else if (isCtrlC) {
      requestPromptShortcut("back");
    } else if ((key && key.name === "f2") || str === "\x1bOQ" || str === "\x1b[12~") {
      requestPromptShortcut("settings");
    }
  };
  process.stdin.on("keypress", onKeypress);
  try {
    rl.on("close", () => process.stdin.off("keypress", onKeypress));
  } catch {}
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--port") out.port = argv[++i];
    else if (a.startsWith("--port=")) out.port = a.slice("--port=".length);
    else if (a === "--chat" || a === "--chatId") out.chat = argv[++i];
    else if (a.startsWith("--chat=")) out.chat = a.slice("--chat=".length);
  }
  return out;
}

function readPortFile() {
  for (const name of [".dos-server-port", ".local-server-port"]) {
    try {
      const raw = fs.readFileSync(path.join(ROOT, name), "utf8").trim();
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {}
  }
  return 0;
}

function loadEnv(file, override) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

function getKey() {
  const raw = process.env.CHAT_DB_ENC_KEY || "";
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

function decryptIfPossible(stored) {
  const text = String(stored || "");
  if (!text.startsWith(ENC_PREFIX)) return text;
  const key = getKey();
  if (!key) return text;
  try {
    const payload = Buffer.from(text.slice(ENC_PREFIX.length), "base64");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const data = payload.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function charWidth(ch) {
  if (!ch) return 0;
  const cp = ch.codePointAt(0);
  if (
    cp === 0 ||
    cp === 0xfe0f ||
    cp === 0xfe0e ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff)
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff)
  ) return 2;
  return 1;
}

function displayWidth(value) {
  let width = 0;
  for (const ch of String(value || "")) width += charWidth(ch);
  return width;
}

function padDisplay(value, width) {
  const s = String(value || "");
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function wrapDisplay(value, width) {
  const words = String(value || "").trim().split(/\s+/g).filter(Boolean);
  if (!words.length) return [""];
  const out = [];
  let line = "";
  let lineWidth = 0;
  const pushLong = (word) => {
    let part = "";
    let partWidth = 0;
    for (const ch of word) {
      const cw = charWidth(ch);
      if (part && partWidth + cw > width) {
        out.push(part);
        part = "";
        partWidth = 0;
      }
      part += ch;
      partWidth += cw;
    }
    return { part, partWidth };
  };
  for (const word of words) {
    const wordWidth = displayWidth(word);
    if (!line) {
      if (wordWidth <= width) {
        line = word;
        lineWidth = wordWidth;
      } else {
        const rest = pushLong(word);
        line = rest.part;
        lineWidth = rest.partWidth;
      }
      continue;
    }
    if (lineWidth + 1 + wordWidth <= width) {
      line += " " + word;
      lineWidth += 1 + wordWidth;
      continue;
    }
    out.push(line);
    if (wordWidth <= width) {
      line = word;
      lineWidth = wordWidth;
    } else {
      const rest = pushLong(word);
      line = rest.part;
      lineWidth = rest.partWidth;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function tableWidth(widths) {
  return widths.reduce((sum, w) => sum + w, 0) + widths.length * 3 + 1;
}

function fitTableWidths(rows, maxWidth) {
  const cols = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: cols }, (_, i) => {
    const maxCell = Math.max(...rows.map((row) => displayWidth(row[i] || "")));
    return Math.max(2, Math.min(maxCell, Math.floor(maxWidth / Math.max(1, cols))));
  });

  if (cols === 3) {
    widths[0] = Math.min(Math.max(widths[0], 8), 24);
    widths[2] = Math.min(Math.max(widths[2], 2), 6);
    widths[1] = Math.max(16, maxWidth - (cols * 3 + 1) - widths[0] - widths[2]);
  }

  while (tableWidth(widths) > maxWidth) {
    let idx = 0;
    for (let i = 1; i < widths.length; i += 1) {
      if (widths[i] > widths[idx]) idx = i;
    }
    if (widths[idx] <= 8) break;
    widths[idx] -= 1;
  }
  return widths;
}

function renderTableRows(rows) {
  if (!rows.length) return "";
  const normalized = rows.map((row) => row.map((cell) => String(cell || "").trim()));
  const cols = Math.max(...normalized.map((row) => row.length));
  const filled = normalized.map((row) => Array.from({ length: cols }, (_, i) => row[i] || ""));
  const maxWidth = Math.max(50, Math.min(process.stdout.columns || 96, 118));
  const widths = fitTableWidths(filled, maxWidth);
  const border = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const out = [border];
  filled.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, i) => wrapDisplay(cell, widths[i]));
    const height = Math.max(...wrapped.map((cellLines) => cellLines.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
      const parts = wrapped.map((cellLines, i) => ` ${padDisplay(cellLines[lineIndex] || "", widths[i])} `);
      out.push("|" + parts.join("|") + "|");
    }
    if (rowIndex === 0 || rowIndex === filled.length - 1) out.push(border);
  });
  return out.join("\n");
}

function renderTabTables(text) {
  const lines = String(text || "").split(/\r?\n/g);
  const out = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    if (group.length >= 2 && group[0].split("\t").length >= 2) {
      out.push(renderTableRows(group.map((line) => line.split("\t"))));
    } else {
      out.push(...group);
    }
    group = [];
  };
  for (const line of lines) {
    const cols = line.split("\t");
    const isTableLine = cols.length >= 2 && cols.some((col) => col.trim());
    if (isTableLine) {
      group.push(line);
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function htmlCellToText(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim();
}

function renderHtmlTables(text) {
  return String(text || "").replace(/<table[\s\S]*?<\/table\s*>/gi, (table) => {
    const rows = [];
    let m = null;
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr\s*>/gi;
    while ((m = trRe.exec(table))) {
      const rowHtml = String(m[1] || "");
      const cells = [];
      let c = null;
      const cellRe = /<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)\s*>/gi;
      while ((c = cellRe.exec(rowHtml))) cells.push(htmlCellToText(c[1]));
      if (cells.length) rows.push(cells);
    }
    return rows.length ? renderTableRows(rows) : "";
  });
}

// (최적화) readonly DB 단일 connection을 process 수명 동안 재사용.
// 매 dbAll/dbGet 호출마다 open/close 하던 비용(SQLite header 파싱 + WAL 페이지 캐시 미스)을 제거.
// better-sqlite3는 statement prepare 결과를 내부 캐싱하므로 재사용 시 추가 이득.
let _roDb = null;
function openDb() {
  if (_roDb) return _roDb;
  _roDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _roDb;
}
process.on("exit", () => {
  try { if (_roDb) _roDb.close(); } catch {}
});

function dbAll(sql, params = []) {
  return openDb().prepare(sql).all(...params);
}

function dbGet(sql, params = []) {
  return openDb().prepare(sql).get(...params);
}

function cleanPromptName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function readPromptPersonaNameFromDb() {
  let name = cleanPromptName(state.settings && state.settings.personaName);
  if (name) return name;

  if (state.chatId) {
    try {
      const row = dbGet(`SELECT personaName FROM chat_settings WHERE chatId=?`, [state.chatId]);
      name = cleanPromptName(row && row.personaName);
      if (name) return name;
    } catch {
      // ignore missing table/row while DOS is starting
    }
  }

  try {
    const row = dbGet(
      `SELECT personaName
         FROM persona_profiles
        WHERE userEmail=?
        ORDER BY updatedAt DESC
        LIMIT 1`,
      [LOCAL_USER_EMAIL]
    );
    name = cleanPromptName(row && row.personaName);
    if (name) return name;
  } catch {
    // older local DBs may not have persona_profiles
  }

  try {
    const row = dbGet(`SELECT personaName FROM user_profile WHERE id=1`);
    name = cleanPromptName(row && row.personaName);
    if (name) return name;
  } catch {
    // older local DBs may not have user_profile
  }

  return "";
}

function getPromptDisplayName() {
  const name = readPromptPersonaNameFromDb();
  if (name) {
    state.settings = { ...(state.settings || {}), personaName: name };
    return name;
  }
  return "ARCA";
}

function textOnly(value, options = {}) {
  // DOS is a discreet monochrome view. Hide emoji only while rendering; the API/DB keeps
  // the original text so server-side status parsing and later prompt context remain intact.
  let s = decryptIfPossible(String(value || ""))
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\p{Emoji_Modifier}/gu, "")
    .replace(/[\u200D\uFE0E\uFE0F]/g, "");

  // (helper) fence body를 들여쓰기 + 빈 줄 제거로 한 덩어리 만든다.
  // - 모델이 상태창 fence 안에 가독성용 빈 줄을 넣으면 "상태창이 떨어져 보이는" 문제 발생
  // - fence 내부는 압축(compact)으로 한 덩어리 형태가 유리
  const formatFenceBody = (body) =>
    String(body || "")
      .trim()
      .split(/\r?\n/g)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0) // 빈 줄 제거 — 상태창 압축
      .map((line) => `  ${line}`)
      .join("\n");

  // 닫힌 fence: ```LABEL\n...\n```
  // 라벨에 한국어/콜론/공백 허용. ("```커스텀동행:미지정" 같은 한국어 라벨 매칭)
  s = s.replace(/```([^\n`]*)\n([\s\S]*?)\n?```/g, (_m, label, body) => {
    const head = String(label || "").trim();
    const title = head ? `ㅁ ${head.toUpperCase()}` : "ㅁ";
    return `${title}\n${formatFenceBody(body)}`;
  });
  // 안전망: 닫는 fence가 누락된 경우에도 시작 fence는 정리해서 raw ```...가 그대로 화면에 보이는 일을 막는다.
  s = s.replace(/```([^\n`]*)\n([\s\S]*)$/g, (_m, label, body) => {
    const head = String(label || "").trim();
    const title = head ? `ㅁ ${head.toUpperCase()}` : "ㅁ";
    return `${title}\n${formatFenceBody(body)}`;
  });
  s = s.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  s = s.replace(/!\[[^\]]*]\[[^\]]*]/g, "");
  s = s.replace(/<img\b[^>]*>/gi, "");
  s = s.replace(/\[[^\]]*]\((?:[^)]*\.(?:png|jpe?g|gif|webp|bmp|svg|avif)[^)]*)\)/gi, "");
  s = s.replace(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|bmp|svg|avif)(?:\?\S*)?/gi, "");
  s = renderHtmlTables(s);
  s = renderTabTables(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  return options.trim === false ? s : s.trim();
}

function oneLine(value, max = 90) {
  const s = textOnly(value)
    .replace(/\*/g, "")
    .replace(/^\s*ㅁ\s+[^\n]*\n?/gm, "")
    .replace(/^\s{2,}/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function roleLabel(role) {
  const r = String(role || "").toLowerCase();
  if (r === "user") return "나";
  if (r === "assistant" || r === "model") return "응답";
  return r || "메시지";
}

function fmtTime(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const d = new Date(n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function hr(title = "") {
  const label = title ? ` ${title} ` : "";
  const width = Math.max(20, Math.min(76, process.stdout.columns || 76));
  const left = Math.floor((width - label.length) / 2);
  const right = Math.max(0, width - label.length - left);
  console.log("=".repeat(Math.max(0, left)) + label + "=".repeat(right));
}

function printWrapped(text, options = {}) {
  const s = textOnly(text);
  if (!s) return;
  process.stdout.write(colorNovelText(s, options));
  if (!s.endsWith("\n")) process.stdout.write("\n");
}

function colorNovelText(text, options = {}) {
  const src = String(text || "");
  if (!src) return "";
  const lines = src.split("\n");
  // (스트리밍 2026-07) options.state = { narr: {inNarration}, inMetaBlock } 를 넘기면
  // 여러 번 나눠 호출해도(델타 flush 단위) 색상 상태가 이어진다. 미전달 시 기존과 동일.
  const externalState = options.state && typeof options.state === "object" ? options.state : null;
  let inMetaBlock = externalState ? Boolean(externalState.inMetaBlock) : false;
  const defaultPlainNarration = options.defaultPlainNarration !== false;
  // Windows Terminal (cmd profile, conhost ConPTY) + 와이드 이모지(💖 등)가 인접 줄에 연속으로 오면
  // cursor advance 계산이 어긋나 다음 줄 첫 셀이 클리핑되는 알려진 버그가 있다.
  // → 각 메타 라인의 "시작에도" ANSI reset+\x1b[K(end-of-line 정리)를 박아서 cursor state를 재초기화한다.
  //   PowerShell profile / 최신 Windows Terminal / WSL 등에서는 본래 잘 동작했고, 추가 처리는 무해.
  const metaLineWrap = (line) => `${ANSI.reset}\x1b[K${ANSI.meta}${line}${ANSI.reset}`;

  // (수정) 멀티라인 지문 색 깨짐 해결.
  // 기존엔 colorNovelInline이 라인별로 호출되며 inNarration이 라인 내부에서만 유지돼,
  // *...로 열고 다음 줄에서 *로 닫는 지문은 첫 줄만 회색, 다음 줄은 흰색으로 나왔음.
  // → narrState 객체를 라인 간 공유해서 *가 줄을 가로질러도 narration 색이 유지되게 함.
  // (스트리밍) externalState.narr가 있으면 그것을 그대로 써서 호출 간에도 유지.
  const narrState = externalState && externalState.narr ? externalState.narr : { inNarration: false };
  const looksLikeDialogueLine = (line) => {
    const s = String(line || "").trimStart();
    if (!s) return false;
    return (
      s.startsWith('"') ||
      s.startsWith("'") ||
      s.startsWith("“") ||
      s.startsWith("‘") ||
      s.startsWith("「") ||
      s.startsWith("『") ||
      /^\[[^\]]{1,40}\]\s*["'“‘「『]/.test(s) ||
      /^[^|:\n]{1,40}\s*[|:]\s*["'“‘「『]/.test(s)
    );
  };
  const unwrapEmphasizedDialogueLine = (line) => {
    const raw = String(line || "");
    const t = raw.trim();
    const m = t.match(/^\*+\s*([\s\S]*?)\s*\*+$/);
    if (!m) return "";
    const inner = String(m[1] || "").trim();
    if (!looksLikeDialogueLine(inner)) return "";
    const indent = raw.match(/^\s*/)?.[0] || "";
    return `${indent}${inner}`;
  };
  const looksLikeTableLine = (line) => {
    const s = String(line || "").trim();
    return /^\+-[-+]+\+$/.test(s) || /^\|.*\|$/.test(s);
  };
  const shouldDefaultToNarration = (line) => {
    const s = String(line || "").trimStart();
    if (!s) return false;
    if (looksLikeDialogueLine(s) || looksLikeTableLine(s)) return false;
    if (/^[=.\-_*]{3,}$/.test(s.trim())) return false;
    if (/^[!/][^\s]+/.test(s)) return false;
    return true;
  };
  const renderedLines = lines
    .map((line) => {
      if (/^ㅁ(?:\s|$)/.test(line)) {
        inMetaBlock = true;
        // 메타 블록 진입 시 narration state 리셋 (메타 이후 본문이 새로 시작될 수 있음)
        narrState.inNarration = false;
        return metaLineWrap(line);
      }
      if (inMetaBlock && /^ {2,}/.test(line)) {
        return metaLineWrap(line);
      }
      if (inMetaBlock) {
        // 메타 블록을 빠져나오는 첫 라인. state 리셋.
        narrState.inNarration = false;
      }
      inMetaBlock = false;
      const emphasizedDialogue = unwrapEmphasizedDialogueLine(line);
      if (emphasizedDialogue) {
        narrState.inNarration = false;
        return `${ANSI.dialogue}${emphasizedDialogue}${ANSI.reset}`;
      }
      if (narrState.inNarration && looksLikeDialogueLine(line)) {
        narrState.inNarration = false;
      }
      if (!narrState.inNarration && looksLikeDialogueLine(line) && !line.includes("*")) {
        return `${ANSI.dialogue}${line}${ANSI.reset}`;
      }
      if (defaultPlainNarration && !narrState.inNarration && !line.includes("*") && shouldDefaultToNarration(line)) {
        return `${ANSI.narration}${line}${ANSI.reset}`;
      }
      return colorNovelInline(line, narrState);
    })
    .join("\n");
  if (externalState) externalState.inMetaBlock = inMetaBlock;
  return renderedLines;
}

function colorNovelInline(text, state) {
  const src = String(text || "");
  if (!src) return "";
  let out = "";
  let buf = "";
  let inNarration = state ? Boolean(state.inNarration) : false;
  let inDialogue = false;
  let dialogueClose = "";
  const quotePairs = { '"': '"', "'": "'", "“": "”", "‘": "’", "「": "」", "『": "』" };
  const flush = () => {
    if (!buf) return;
    out += (inDialogue ? ANSI.dialogue : inNarration ? ANSI.narration : ANSI.soft) + buf + ANSI.reset;
    buf = "";
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "*") {
      flush();
      let end = i + 1;
      while (end < src.length && src[end] === "*") end += 1;
      const count = end - i;
      if (count === 1) {
        inNarration = !inNarration;
      } else {
        const atStart = src.slice(0, i).trim().length === 0;
        const atEnd = src.slice(end).trim().length === 0;
        if (!inNarration && atStart) inNarration = true;
        else if (inNarration && atEnd) inNarration = false;
      }
      i = end - 1;
      continue;
    }
    if (!inDialogue && Object.prototype.hasOwnProperty.call(quotePairs, ch)) {
      flush();
      inDialogue = true;
      dialogueClose = quotePairs[ch];
      buf += ch;
      continue;
    }
    if (inDialogue && ch === dialogueClose) {
      buf += ch;
      flush();
      inDialogue = false;
      dialogueClose = "";
      continue;
    }
    buf += ch;
  }
  flush();
  if (state) state.inNarration = inNarration;
  return out;
}

// ── 스트리밍 렌더러 (2026-07, gemini-3-pro 실시간 delta 복구 대응) ──────────────
// textOnly()의 fence(```)→"ㅁ 라벨" 변환과 colorNovelText()의 색상 상태는
// "완결된 블록/줄" 전제라서, 델타 조각을 그대로 넘기면 화면이 깨진다.
// 원칙:
//  - 완결된 줄 단위로만 출력한다 (마지막 미완 줄은 다음 델타까지 보류)
//  - 여는 fence(```)를 만나면 닫힐 때까지 블록 전체를 보류했다가 한 번에 출력한다
//    (서버가 metaFenceMaxChars로 fence 크기를 캡하므로 보류량은 유한)
//  - 색상 상태(지문 * / 메타 블록)는 colorState로 flush 간 유지한다
//  - finish() 시 남은 보류분을 전부 출력한다 (미닫힘 fence는 textOnly 안전망이 정리)
function createStreamRenderer(write) {
  const colorState = { narr: { inNarration: false }, inMetaBlock: false };
  let pending = "";
  let printed = "";

  const isFenceLine = (line) => /^[ \t]*```/.test(line);

  // pending 중 "지금 안전하게 렌더링 가능한 프리픽스 길이"를 구한다.
  const flushableLen = () => {
    const lastNl = pending.lastIndexOf("\n");
    if (lastNl < 0) return 0; // 완결된 줄이 아직 없음
    const complete = pending.slice(0, lastNl + 1);
    const lines = complete.split("\n"); // 마지막 원소는 "" (trailing \n)
    let offset = 0;
    let open = false;
    let fenceOpenAt = -1;
    for (let i = 0; i < lines.length - 1; i += 1) {
      const line = lines[i];
      if (isFenceLine(line)) {
        if (!open) {
          open = true;
          fenceOpenAt = offset;
        } else {
          open = false;
          fenceOpenAt = -1;
        }
      }
      offset += line.length + 1;
    }
    return open ? fenceOpenAt : complete.length;
  };

  const emit = (chunk) => {
    if (!chunk) return;
    const cleaned = textOnly(chunk, { trim: false });
    if (!cleaned) return;
    const rendered = colorNovelText(cleaned, { state: colorState });
    if (!rendered) return;
    printed += cleaned;
    write(rendered);
  };

  return {
    push(text) {
      pending += String(text || "");
      const n = flushableLen();
      if (n > 0) {
        const chunk = pending.slice(0, n);
        pending = pending.slice(n);
        emit(chunk);
      }
    },
    finish() {
      if (!pending) return;
      const chunk = pending;
      pending = "";
      emit(chunk);
    },
    printedText() {
      return printed;
    },
  };
}

// ── 터미널 페이서 (2026-07) ──────────────────────────────────────────────
// 웹 UI의 stream pacer와 동일 컨셉: 모델/서버가 델타를 묶음(문단)으로 뱉어도
// 화면엔 일정 속도(≈초당 375자)로 몇 글자씩 흘려보내 자연스러운 타이핑 체감을 만든다.
// - ANSI 이스케이프 시퀀스는 통짜 1유닛(가시 폭 0)으로 취급해 중간에서 쪼개지 않는다
// - 스트리밍 중엔 약간의 잔량(backlog)을 유지해 "멈췄다 쏟아짐"을 완화
// - 델타가 IDLE_FLUSH_MS 이상 끊기면 잔량 제한을 풀고 빠르게 소진
function createTerminalPacer(writeOut) {
  const PACE_MS = 16; // ≈60fps
  const CHARS_PER_TICK = 6; // 6ch/16ms ≈ 375 chars/sec (웹 pacer와 동일 체감)
  const TARGET_BACKLOG = 120; // 스트리밍 중 버퍼 고갈(뚝뚝 끊김) 방지용 최소 잔량
  const IDLE_FLUSH_MS = 300;

  const units = []; // 각 원소 = 가시 문자 1개 또는 ANSI 시퀀스 1개
  let timer = null;
  let lastPushAt = 0;
  let emittedAny = false;
  let firstEmitCb = null;

  const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
  const tokenize = (s) => {
    let i = 0;
    let m;
    ANSI_RE.lastIndex = 0;
    while ((m = ANSI_RE.exec(s))) {
      for (const ch of s.slice(i, m.index)) units.push(ch);
      units.push(m[0]);
      i = m.index + m[0].length;
    }
    for (const ch of s.slice(i)) units.push(ch);
  };

  const visibleCount = () => {
    let n = 0;
    for (const u of units) if (!(u.length > 1 && u.charCodeAt(0) === 27)) n += 1;
    return n;
  };

  const emitUnits = (nVisible) => {
    if (!units.length || nVisible <= 0) return;
    let out = "";
    let vis = 0;
    while (units.length && vis < nVisible) {
      const u = units.shift();
      out += u;
      if (!(u.length > 1 && u.charCodeAt(0) === 27)) vis += 1;
    }
    // 뒤따르는 이스케이프(리셋 등)는 같은 write에 실어 색이 다음 틱으로 밀리지 않게 한다
    while (units.length && units[0].length > 1 && units[0].charCodeAt(0) === 27) out += units.shift();
    if (out) {
      if (!emittedAny) {
        emittedAny = true;
        try {
          firstEmitCb && firstEmitCb();
        } catch {}
      }
      writeOut(out);
    }
  };

  const tick = () => {
    if (!units.length) {
      // 큐가 비면 타이머 정지 (push 시 재가동)
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }
    const idle = lastPushAt > 0 && Date.now() - lastPushAt >= IDLE_FLUSH_MS;
    if (idle) {
      emitUnits(CHARS_PER_TICK * 5); // 델타 공백: 잔량 빠르게 소진 (≈1875 chars/sec)
      return;
    }
    // (튜닝 2026-07) 3 Pro는 thinking 후 본문을 몰아서 뱉는다(모델 자체 ≈500자/초).
    // 페이서가 그보다 느리면 "다 나온 걸 붙잡고 늘어지는" 체감이 되므로,
    // 잔량이 클수록 공격적으로 따라잡아 총 표시시간이 one-shot 대비 거의 늘지 않게 한다.
    const vis = visibleCount();
    if (vis > TARGET_BACKLOG * 8) emitUnits(CHARS_PER_TICK * 5); // >960: ≈1875 chars/sec (폭주 따라잡기)
    else if (vis > TARGET_BACKLOG * 4) emitUnits(CHARS_PER_TICK * 3); // >480: ≈1125 chars/sec
    else if (vis > TARGET_BACKLOG) emitUnits(CHARS_PER_TICK * 1.5); // >120: ≈560 chars/sec (모델 생산속도와 비슷)
    else emitUnits(3); // 잔량 적음: 아껴 쓰며 버퍼 고갈 방지 (≈190 chars/sec)
  };

  const ensureTimer = () => {
    if (!timer) timer = setInterval(tick, PACE_MS);
  };

  return {
    onFirstEmit(cb) {
      firstEmitCb = cb;
    },
    push(s) {
      const str = String(s || "");
      if (!str) return;
      tokenize(str);
      lastPushAt = Date.now();
      ensureTimer();
    },
    // done 이후: 남은 잔량을 "빠른 타이핑" 속도로 마저 흘려보낸다 (통짜 덤프 방지)
    async drain() {
      while (units.length) {
        emitUnits(CHARS_PER_TICK * 6); // ≈2250 chars/sec — 완료 후 꼬리는 즉시 수준으로
        if (!units.length) break;
        await new Promise((r) => setTimeout(r, PACE_MS));
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    // 취소/에러: 즉시 정지 (잔량 파기)
    stop() {
      units.length = 0;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function colorLine(text, color) {
  return `${color}${text}${ANSI.reset}`;
}

function startResponseStatus(started) {
  const frames = ["-", "\\", "|", "/"];
  let frame = 0;
  let active = true;
  let visible = false;
  const render = () => {
    if (!active) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const text = `${ANSI.gray}${frames[frame % frames.length]} 응답 생성 중... ${elapsed}초${ANSI.reset}`;
    frame += 1;
    process.stdout.write(`\r\x1b[2K${text}`);
    visible = true;
  };
  render();
  const timer = setInterval(render, 1000);
  return {
    stop(clearLine = true) {
      if (!active) return;
      active = false;
      clearInterval(timer);
      if (clearLine && visible) process.stdout.write("\r\x1b[2K");
    },
  };
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "-";
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}초`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function printTimingSummary(timing) {
  if (!timing) return;
  console.log(`${ANSI.gray}자세히: /time${ANSI.reset}`);
}

function cleanServerTimingLabel(label) {
  let s = String(label || "").trim();
  if (!s) return "기타";
  s = s.split(":")[0] || s;
  if (s === "send.total") return "서버 전체";
  if (s === "send.prompt.build") return "프롬프트 구성";
  if (s === "send.gemini.call") return "모델 호출";
  if (s === "send.gemini.stream") return "모델 호출/수신";
  if (s === "send.postprocess") return "서버 후처리";
  if (s.startsWith("step.db.")) return `DB ${s.slice("step.db.".length) || ""}`.trim();
  if (s.startsWith("step.")) return s.slice("step.".length);
  if (s.startsWith("send.")) return s.slice("send.".length);
  return s;
}

function getServerTimings(usage) {
  const rows = Array.isArray(usage?.serverTimings) ? usage.serverTimings : [];
  return rows
    .map((row) => ({
      label: cleanServerTimingLabel(row?.label),
      rawLabel: String(row?.label || ""),
      ms: num(row?.ms),
    }))
    .filter((row) => row.ms > 0);
}

function printServerTimingCompact(usage) {
  const rows = getServerTimings(usage);
  if (!rows.length) return;
  const picked = rows
    .filter((row) => row.label !== "서버 전체")
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6);
  if (!picked.length) return;
  console.log(`${ANSI.gray}[서버상세] ${picked.map((row) => `${row.label} ${fmtMs(row.ms)}`).join(" | ")}${ANSI.reset}`);
}

function printTimingDetail(timing = state.lastTiming) {
  if (!timing) {
    console.log("아직 기록된 응답 시간이 없습니다.");
    return;
  }
  const usage = timing.usage || {};
  hr("세부 시간");
  console.log(`응답 전체        : ${fmtMs(timing.responseMs)}`);
  console.log(`서버 연결/대기   : ${fmtMs(timing.headerWaitMs)}`);
  console.log(`첫 신호 대기     : ${fmtMs(timing.firstSignalWaitMs)}`);
  console.log(`첫 글자 대기     : ${fmtMs(timing.firstOutputWaitMs)}`);
  console.log(`수신/출력 구간   : ${fmtMs(timing.receiveMs)}`);
  if (num(usage.latencyMs) > 0) console.log(`모델 API         : ${fmtMs(usage.latencyMs)}`);
  if (typeof timing.memoryMs === "number") console.log(`장기기억 갱신    : ${fmtMs(timing.memoryMs)}`);
  if (typeof timing.characterMs === "number") console.log(`캐릭터 기록      : ${fmtMs(timing.characterMs)}`);
  if (typeof timing.afterWorkMs === "number") console.log(`후처리 합계      : ${fmtMs(timing.afterWorkMs)}`);
  console.log(`완료까지 총합    : ${fmtMs(timing.totalWithAfterMs)}`);
  console.log("");
  console.log(`모델             : ${usage.model || timing.model || "-"}`);
  console.log(`토큰             : 입력 ${num(usage.promptTokens)} / 출력 ${num(usage.outputTokens)} / 추론 ${num(usage.reasoningTokens)} / 합계 ${num(usage.totalTokens)}`);
  if (usage.finishReason) console.log(`finishReason     : ${usage.finishReason}`);
  if (usage.thinkingLevel) console.log(`thinkingLevel    : ${usage.thinkingLevel}`);
  const serverRows = getServerTimings(usage);
  if (serverRows.length) {
    console.log("");
    hr("서버 내부");
    for (const row of serverRows) {
      console.log(`${row.label.padEnd(18, " ")}: ${fmtMs(row.ms)}`);
    }
  }
}

function listChats(limit = 15) {
  const rows = dbAll(
    `
    SELECT
      c.id,
      c.presetId,
      COALESCE(NULLIF(c.title, ''), NULLIF(p.name, ''), NULLIF(p.characterName, ''), '채팅') AS title,
      MAX(
        COALESCE(c.lastStatusUpdatedAt, 0),
        COALESCE((SELECT MAX(COALESCE(mx.updatedAt, mx.createdAt)) FROM messages mx WHERE mx.chatId = c.id), 0),
        COALESCE(c.createdAt, 0)
      ) AS updatedAt,
      p.name AS presetName,
      p.characterName AS characterName,
      (
        SELECT m.content
        FROM messages m
        WHERE m.chatId = c.id
        ORDER BY COALESCE(m.updatedAt, m.createdAt) DESC, m.id DESC
        LIMIT 1
      ) AS lastContent,
      (
        SELECT COUNT(*)
        FROM messages m2
        WHERE m2.chatId = c.id
      ) AS messageCount
    FROM chats c
    LEFT JOIN presets p ON p.id = c.presetId
    WHERE LOWER(COALESCE(c.userEmail, '')) = ?
    ORDER BY updatedAt DESC, c.id DESC
    LIMIT ?
    `,
    [LOCAL_USER_EMAIL, limit]
  );
  return rows.map((r) => ({
    id: String(r.id || ""),
    presetId: r.presetId ? String(r.presetId) : "",
    title: String(r.title || r.presetName || r.characterName || "채팅"),
    updatedAt: Number(r.updatedAt || 0),
    lastContent: textOnly(r.lastContent || ""),
    messageCount: Number(r.messageCount || 0),
  }));
}

function listChatsForPreset(presetId, limit = 10) {
  const rows = dbAll(
    `
    SELECT
      c.id,
      c.presetId,
      COALESCE(NULLIF(c.title, ''), NULLIF(p.name, ''), NULLIF(p.characterName, ''), '채팅') AS title,
      MAX(
        COALESCE(c.lastStatusUpdatedAt, 0),
        COALESCE((SELECT MAX(COALESCE(mx.updatedAt, mx.createdAt)) FROM messages mx WHERE mx.chatId = c.id), 0),
        COALESCE(c.createdAt, 0)
      ) AS updatedAt,
      (
        SELECT m.content
        FROM messages m
        WHERE m.chatId = c.id
        ORDER BY COALESCE(m.updatedAt, m.createdAt) DESC, m.id DESC
        LIMIT 1
      ) AS lastContent,
      (
        SELECT COUNT(*)
        FROM messages m2
        WHERE m2.chatId = c.id
      ) AS messageCount
    FROM chats c
    LEFT JOIN presets p ON p.id = c.presetId
    WHERE c.presetId=? AND LOWER(COALESCE(c.userEmail, '')) = ?
    ORDER BY updatedAt DESC, c.id DESC
    LIMIT ?
    `,
    [presetId, LOCAL_USER_EMAIL, limit]
  );
  return rows.map((r) => ({
    id: String(r.id || ""),
    presetId: r.presetId ? String(r.presetId) : "",
    title: String(r.title || "채팅"),
    updatedAt: Number(r.updatedAt || 0),
    lastContent: textOnly(r.lastContent || ""),
    messageCount: Number(r.messageCount || 0),
  }));
}

function listPresets(limit = 30) {
  // (변경) 공용 readonly connection 재사용. close 불필요.
  const db = openDb();
  {
    const rows = db
      .prepare(
        `
        SELECT id, name, characterName, createdAt
        FROM presets
        ORDER BY COALESCE(createdAt, 0) DESC, id DESC
        LIMIT ?
        `
      )
      .all(limit);
    // (안정성) 작품별 "이어하기" 후보 chat을 찾을 때 본인 소유 chat만 고려한다.
    // - 마이그레이션 후 모든 chat이 LOCAL_USER_EMAIL인 상태라 결과는 같지만,
    //   필터를 명시해 두면 새로 추가되는 데이터에도 안전.
    const latestStmt = db.prepare(
      `
      SELECT
        id,
        MAX(
          COALESCE(lastStatusUpdatedAt, 0),
          COALESCE((SELECT MAX(COALESCE(m.updatedAt, m.createdAt)) FROM messages m WHERE m.chatId = chats.id), 0),
          COALESCE(createdAt, 0)
        ) AS updatedAt
      FROM chats
      WHERE presetId=? AND LOWER(COALESCE(userEmail,'')) = ?
      ORDER BY updatedAt DESC, id DESC
      LIMIT 1
      `
    );
    const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE chatId=?`);
    const result = rows.map((r) => {
      const latest = latestStmt.get(r.id, LOCAL_USER_EMAIL) || {};
      const count = latest.id ? countStmt.get(latest.id) || {} : {};
      return {
        id: String(r.id || ""),
        title: String(r.name || r.characterName || "작품"),
        characterName: String(r.characterName || ""),
        createdAt: Number(r.createdAt || 0),
        latestChatId: latest.id ? String(latest.id) : "",
        latestChatAt: Number(latest.updatedAt || 0),
        latestMessageCount: Number(count.cnt || 0),
      };
    });
    // (정렬) 이어하기 가능한 작품(=가장 최근에 채팅한 작품)을 위로.
    // - 1순위: 최근 채팅 시각 desc (latestChatAt)
    // - 2순위: 작품 생성 시각 desc (createdAt) — 이어하기 없는 작품들 사이 정렬용
    result.sort((a, b) => {
      if (b.latestChatAt !== a.latestChatAt) return b.latestChatAt - a.latestChatAt;
      return b.createdAt - a.createdAt;
    });
    return result;
  }
}

async function apiJson(urlPath, options = {}) {
  const opts = { ...options };
  // caller가 signal을 주지 않으면 현재 활성 AbortController를 자동으로 연결 → Ctrl+C로 취소 가능.
  if (!opts.signal && state.activeController) opts.signal = state.activeController.signal;
  opts.headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  const res = await fetch(`${API_BASE}${urlPath}`, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const msg = json && (json.error || json.detail) ? `${json.error || ""} ${json.detail || ""}`.trim() : text;
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return json;
}

async function health() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, { cache: "no-store" });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
}

// (최적화) chat 단위로 settings를 짧게 캐시 (60초 TTL).
// 매 send 직전 loadSettings()가 HTTP RTT를 발생시키던 비용 제거.
// 변경 명령(/model /output /reason /persona)은 응답으로 받은 새 settings로 cache도 함께 갱신.
const _settingsCache = { chatId: "", at: 0, value: null };
const SETTINGS_TTL_MS = 60_000;

function applySettings(s) {
  state.settings = s || null;
  _settingsCache.chatId = state.chatId;
  _settingsCache.at = Date.now();
  _settingsCache.value = state.settings;
}

async function loadSettings(opts) {
  if (!state.chatId) return null;
  const force = Boolean(opts && opts.force);
  if (
    !force &&
    _settingsCache.chatId === state.chatId &&
    _settingsCache.value &&
    Date.now() - _settingsCache.at < SETTINGS_TTL_MS
  ) {
    state.settings = _settingsCache.value;
    return state.settings;
  }
  const json = await apiJson(`/api/chat/settings?chatId=${encodeURIComponent(state.chatId)}`);
  applySettings(json && json.settings ? json.settings : null);
  return state.settings;
}

async function showSettings() {
  const st = await loadSettings();
  if (!st) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  hr("설정");
  console.log(`모델        : ${st.model || "-"}`);
  const outLevel = inferLevel(OUTPUT_PRESETS, st.maxOutputTokens);
  console.log(`출력 길이   : ${LEVEL_LABEL[outLevel]} (${OUTPUT_PRESETS[outLevel]}자 목표 / 현재 ${st.maxOutputTokens || "-"})`);
  const rPresets = getReasoningPresets(st.model);
  const rLevel = inferLevel(rPresets, st.maxReasoningTokens);

  // 마지막 호출의 실측 reasoning 토큰 (참고용). Gemini 3 Pro는 설정값과
  // 실제 사용량이 크게 다를 수 있어 명시적으로 보여준다.
  const lastUsage = readLastUsageForChat(state.chatId);
  const isGemini3ProModel = isGemini3ProFamilyModel(st.model);
  if (isGemini3ProModel) {
    const actual = lastUsage ? lastUsage.reasoningTokens : null;
    const lvl = lastUsage ? lastUsage.thinkingLevel : "";
    const actualStr = actual != null ? `${actual} 토큰` : "기록 없음";
    const lvlStr = lvl ? ` / 단계="${lvl}"` : "";
    console.log(`추론 토큰   : ${reasoningLevelLabel(st.model, rLevel)} (설정 힌트 ${rPresets[rLevel]} / 마지막 실측 ${actualStr}${lvlStr})`);
    console.log(`            ※ Gemini 3 Pro는 'low/medium/high' 단계만 받고 실제 사용량은 모델이 결정함`);
  } else {
    const actual = lastUsage ? lastUsage.reasoningTokens : null;
    const actualStr = actual != null ? `${actual} 토큰` : "기록 없음";
    console.log(`추론 토큰   : ${reasoningLevelLabel(st.model, rLevel)} (${rPresets[rLevel]} 토큰 / 현재 ${st.maxReasoningTokens ?? "-"} / 마지막 실측 ${actualStr})`);
  }

  console.log(`최근 원문   : ${st.memoryFrom || 7}턴`);
  console.log(`장기요약    : ${st.summaryEvery || 3}턴마다`);
  console.log(`페르소나    : ${st.personaName || "-"}`);
}

function readLastUsageForChat(chatId) {
  if (!chatId) return null;
  try {
    const row = dbGet(
      `SELECT reasoningTokens, thinkingLevel, thinkingBudget, createdAt
       FROM message_usage
       WHERE chatId=?
       ORDER BY createdAt DESC
       LIMIT 1`,
      [chatId]
    );
    if (!row) return null;
    return {
      reasoningTokens: Number(row.reasoningTokens || 0),
      thinkingLevel: String(row.thinkingLevel || ""),
      thinkingBudget: Number(row.thinkingBudget || 0),
      createdAt: Number(row.createdAt || 0),
    };
  } catch {
    return null;
  }
}

function printChats(chats) {
  state.recentChats = chats;
  hr("채팅 목록");
  if (!chats.length) {
    console.log("아직 채팅이 없습니다. /presets 후 /new 번호 로 시작하세요.");
    return;
  }
  chats.forEach((chat, i) => {
    const marker = chat.id === state.chatId ? "*" : " ";
    const tail = chat.lastContent ? ` - ${oneLine(chat.lastContent, 70)}` : "";
    console.log(`${marker}${String(i + 1).padStart(2, " ")}. ${chat.title} (${chat.messageCount}개, ${fmtTime(chat.updatedAt)})${tail}`);
  });
}

function printPresets(presets) {
  state.recentPresets = presets;
  hr("작품 목록");
  if (!presets.length) {
    console.log("등록된 작품이 없습니다.");
    return;
  }
  presets.forEach((preset, i) => {
    // characterName이 title과 같으면 옆에 또 표시하지 않는다 (중복 제거).
    const charName = String(preset.characterName || "").trim();
    const titleName = String(preset.title || "").trim();
    const who = charName && charName !== titleName ? ` / ${charName}` : "";
    const resume = preset.latestChatId ? "[이어하기]" : "[이어없음]";
    console.log(`${String(i + 1).padStart(2, " ")}. ${preset.title}${who} ${resume} [처음하기]`);
  });
}

function trimMenuText(value, max = 28) {
  const chars = Array.from(String(value || ""));
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function parseMouseSgr(text) {
  const m = String(text || "").match(/\x1b\[<(\d+);(\d+);(\d+)([mM])/);
  if (!m || m[4] !== "M") return null;
  const button = Number(m[1]);
  if (button !== 0) return null;
  return { col: Number(m[2]), row: Number(m[3]) };
}

function renderPresetLauncher(presets, selectedIndex, actionMode, typed) {
  clearScreen();
  const lines = [];
  const rows = [];
  lines.push(`${ANSI.bold}${ANSI.title}ARCA DOS CHAT - 작품 선택${ANSI.reset}`);
  lines.push(`${ANSI.gray}마우스 클릭 지원 콘솔에서는 [이어하기]/[처음하기]를 바로 누를 수 있습니다. 번호+Enter도 됩니다.${ANSI.reset}`);
  lines.push(`${ANSI.gray}↑↓ 선택  Enter 실행  N 처음하기  C 이어하기  Q 종료${ANSI.reset}`);
  lines.push("");

  presets.forEach((preset, i) => {
    const rowNo = lines.length + 1;
    const selected = i === selectedIndex;
    const index = String(i + 1).padStart(2, " ");
    const title = trimMenuText(preset.title, 30).padEnd(31, " ");
    // (수정) characterName이 title과 같거나 비어있으면 옆에 또 표시하지 않는다.
    // (사용자 작품 대부분 title==characterName 이라 중복 노이즈가 컸음.)
    const charName = String(preset.characterName || "").trim();
    const titleName = String(preset.title || "").trim();
    const who = charName && charName !== titleName ? trimMenuText(charName, 14) : "";
    const canResume = Boolean(preset.latestChatId);
    const resumePlain = canResume ? "[이어하기]" : "[이어없음]";
    const newPlain = "[처음하기]";
    const currentAction = canResume ? actionMode : "new";
    const resumeColor = canResume ? (selected && currentAction === "continue" ? ANSI.reverse + ANSI.green : ANSI.green) : ANSI.gray;
    const newColor = selected && currentAction === "new" ? ANSI.reverse + ANSI.accent : ANSI.accent;
    const cursor = selected ? `${ANSI.yellow}>${ANSI.reset}` : " ";

    const plainPrefix = `${cursor}${index}. `;
    const resumeStart = 6;
    const resumeEnd = 18;
    const newStart = 20;
    const newEnd = 32;

    const whoSegment = who ? ` ${ANSI.gray}/ ${who}${ANSI.reset}` : "";
    lines.push(
      `${plainPrefix}${resumeColor}${resumePlain}${ANSI.reset} ${newColor}${newPlain}${ANSI.reset} ${title}${whoSegment}`
    );
    rows.push({ row: rowNo, index: i, resumeStart, resumeEnd, newStart, newEnd });
  });

  if (typed) lines.push(`\n${ANSI.yellow}입력 번호: ${typed}${ANSI.reset}`);
  process.stdout.write(`${ANSI.hideCursor}${lines.join("\n")}\n`);
  return rows;
}

async function choosePresetAction(presets) {
  if (!presets.length) return null;
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    printPresets(presets);
    return null;
  }

  let selectedIndex = 0;
  let actionMode = presets[0].latestChatId ? "continue" : "new";
  let typed = "";
  let rows = [];

  const normalizeAction = () => {
    if (!presets[selectedIndex].latestChatId) actionMode = "new";
    if (actionMode !== "new" && actionMode !== "continue") {
      actionMode = presets[selectedIndex].latestChatId ? "continue" : "new";
    }
  };

  const pick = (index, action) => {
    const preset = presets[index];
    if (!preset) return null;
    const finalAction = action === "continue" && preset.latestChatId ? "continue" : "new";
    return { preset, action: finalAction };
  };

  return await new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const render = () => {
      normalizeAction();
      rows = renderPresetLauncher(presets, selectedIndex, actionMode, typed);
    };
    const cleanup = (value) => {
      stdin.off("data", onData);
      process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.reset}`);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {}
      resolve(value);
    };
    const onData = (buf) => {
      const s = buf.toString("utf8");
      if (s === "\u0003") {
        cleanup(null);
        return;
      }
      const mouse = parseMouseSgr(s);
      if (mouse) {
        const hit = rows.find((r) => r.row === mouse.row);
        if (hit) {
          selectedIndex = hit.index;
          let action = presets[selectedIndex].latestChatId ? "continue" : "new";
          if (mouse.col >= hit.newStart && mouse.col <= hit.newEnd) action = "new";
          else if (mouse.col >= hit.resumeStart && mouse.col <= hit.resumeEnd) action = "continue";
          cleanup(pick(selectedIndex, action));
        }
        return;
      }
      if (s === "\x1b[A") {
        selectedIndex = Math.max(0, selectedIndex - 1);
        typed = "";
        if (!presets[selectedIndex].latestChatId) actionMode = "new";
        render();
        return;
      }
      if (s === "\x1b[B") {
        selectedIndex = Math.min(presets.length - 1, selectedIndex + 1);
        typed = "";
        if (!presets[selectedIndex].latestChatId) actionMode = "new";
        render();
        return;
      }
      if (s === "\x1b[C" || s.toLowerCase() === "n") {
        actionMode = "new";
        render();
        return;
      }
      if (s === "\x1b[D" || s.toLowerCase() === "c") {
        actionMode = presets[selectedIndex].latestChatId ? "continue" : "new";
        render();
        return;
      }
      if (s === "q" || s === "Q" || s === "\x1b") {
        cleanup(null);
        return;
      }
      if (/^\d$/.test(s)) {
        typed = (typed + s).slice(0, 3);
        render();
        return;
      }
      if (s === "\b" || s === "\x7f") {
        typed = typed.slice(0, -1);
        render();
        return;
      }
      if (s === "\r" || s === "\n") {
        if (typed) {
          const index = Number(typed) - 1;
          if (index >= 0 && index < presets.length) {
            cleanup(pick(index, presets[index].latestChatId ? "continue" : "new"));
            return;
          }
          typed = "";
          render();
          return;
        }
        cleanup(pick(selectedIndex, actionMode));
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(ANSI.mouseOn);
    render();
    stdin.on("data", onData);
  });
}

function renderContinueLauncher(preset, chats, selectedIndex, typed) {
  clearScreen();
  const lines = [];
  const rows = [];
  lines.push(`${ANSI.bold}${ANSI.title}ARCA DOS CHAT - 이어할 채팅 선택${ANSI.reset}`);
  lines.push(`${ANSI.gray}${preset.title} / 최근순입니다. 클릭 또는 번호+Enter로 들어갑니다. B 또는 Esc는 작품 목록.${ANSI.reset}`);
  lines.push(`${ANSI.gray}↑↓ 선택  Enter 들어가기  B 뒤로  Q 종료${ANSI.reset}`);
  lines.push("");

  chats.forEach((chat, i) => {
    const rowNo = lines.length + 1;
    const selected = i === selectedIndex;
    const index = String(i + 1).padStart(2, " ");
    const cursor = selected ? `${ANSI.yellow}>${ANSI.reset}` : " ";
    const title = trimMenuText(chat.title, 24).padEnd(25, " ");
    const preview = oneLine(chat.lastContent || "", 52);
    const color = selected ? ANSI.reverse + ANSI.green : ANSI.green;
    const meta = `${chat.messageCount || 0}개 ${fmtTime(chat.updatedAt)}`;
    const previewPart = preview ? ` ${ANSI.soft}${preview}${ANSI.reset}` : "";
    lines.push(
      `${cursor}${index}. ${color}[들어가기]${ANSI.reset} ${title} ${ANSI.gray}${meta}${ANSI.reset}${previewPart}`
    );
    rows.push({ row: rowNo, index: i });
  });

  if (typed) lines.push(`\n${ANSI.yellow}입력 번호: ${typed}${ANSI.reset}`);
  process.stdout.write(`${ANSI.hideCursor}${lines.join("\n")}\n`);
  return rows;
}

async function chooseContinueChat(preset) {
  const chats = listChatsForPreset(preset.id, 12);
  if (!chats.length) return { back: true };
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    printChats(chats);
    return { chat: chats[0] };
  }

  let selectedIndex = 0;
  let typed = "";
  let rows = [];

  return await new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const render = () => {
      rows = renderContinueLauncher(preset, chats, selectedIndex, typed);
    };
    const cleanup = (value) => {
      stdin.off("data", onData);
      process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.reset}`);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {}
      resolve(value);
    };
    const pick = (index) => {
      const chat = chats[index];
      return chat ? { chat } : { back: true };
    };
    const onData = (buf) => {
      const s = buf.toString("utf8");
      if (s === "\u0003") {
        cleanup({ back: true });
        return;
      }
      const mouse = parseMouseSgr(s);
      if (mouse) {
        const hit = rows.find((r) => r.row === mouse.row);
        if (hit) cleanup(pick(hit.index));
        return;
      }
      if (s === "\x1b[A") {
        selectedIndex = Math.max(0, selectedIndex - 1);
        typed = "";
        render();
        return;
      }
      if (s === "\x1b[B") {
        selectedIndex = Math.min(chats.length - 1, selectedIndex + 1);
        typed = "";
        render();
        return;
      }
      if (s === "b" || s === "B" || s === "\x1b") {
        cleanup({ back: true });
        return;
      }
      if (s === "q" || s === "Q") {
        cleanup(null);
        return;
      }
      if (/^\d$/.test(s)) {
        typed = (typed + s).slice(0, 3);
        render();
        return;
      }
      if (s === "\b" || s === "\x7f") {
        typed = typed.slice(0, -1);
        render();
        return;
      }
      if (s === "\r" || s === "\n") {
        if (typed) {
          const index = Number(typed) - 1;
          if (index >= 0 && index < chats.length) {
            cleanup(pick(index));
            return;
          }
          typed = "";
          render();
          return;
        }
        cleanup(pick(selectedIndex));
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(ANSI.mouseOn);
    render();
    stdin.on("data", onData);
  });
}

function modelByInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= MODEL_OPTIONS.length) {
    return MODEL_OPTIONS[n - 1].id;
  }
  const found = MODEL_OPTIONS.find((m) => m.id === raw || m.label.toLowerCase() === raw.toLowerCase());
  return found ? found.id : raw;
}

function renderModelLauncher(selectedIndex, typed, currentModel) {
  clearScreen();
  const lines = [];
  const rows = [];
  const currentLabel = MODEL_OPTIONS.find((m) => m.id === currentModel)?.label || currentModel || "-";
  lines.push(`${ANSI.bold}${ANSI.title}ARCA DOS CHAT - 모델 선택${ANSI.reset}`);
  lines.push(`${ANSI.green}현재 모델: ${currentLabel} (${currentModel || "-"})${ANSI.reset}`);
  lines.push(`${ANSI.gray}클릭 또는 번호+Enter로 고릅니다. Esc/Q는 취소.${ANSI.reset}`);
  lines.push("");

  MODEL_OPTIONS.forEach((model, i) => {
    const rowNo = lines.length + 1;
    const selected = i === selectedIndex;
    const current = model.id === currentModel ? "  <현재>" : "";
    const cursor = selected ? `${ANSI.yellow}>${ANSI.reset}` : " ";
    const color = selected ? ANSI.reverse + ANSI.accent : ANSI.accent;
    lines.push(
      `${cursor}${String(i + 1).padStart(2, " ")}. ${color}[선택]${ANSI.reset} ${model.label.padEnd(24, " ")} ${ANSI.gray}${model.id}${current}${ANSI.reset}`
    );
    rows.push({ row: rowNo, index: i });
  });

  if (typed) lines.push(`\n${ANSI.yellow}입력 번호: ${typed}${ANSI.reset}`);
  process.stdout.write(`${ANSI.hideCursor}${lines.join("\n")}\n`);
  return rows;
}

async function chooseModelMenu(rl) {
  const st = await loadSettings();
  const currentModel = String(st?.model || "");
  let selectedIndex = Math.max(0, MODEL_OPTIONS.findIndex((m) => m.id === currentModel));
  let typed = "";
  let rows = [];

  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    MODEL_OPTIONS.forEach((m, i) => console.log(`${i + 1}. ${m.label} (${m.id})`));
    return "";
  }

  return await new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let suspendedKeypressListeners = [];
    let keypressListenersRestored = false;
    const suspendChatKeypressListeners = () => {
      suspendedKeypressListeners = stdin.listeners("keypress");
      for (const listener of suspendedKeypressListeners) stdin.off("keypress", listener);
    };
    const restoreChatKeypressListeners = () => {
      if (keypressListenersRestored) return;
      keypressListenersRestored = true;
      for (const listener of suspendedKeypressListeners) stdin.on("keypress", listener);
    };
    const render = () => {
      rows = renderModelLauncher(selectedIndex, typed, currentModel);
    };
    const cleanup = (value) => {
      stdin.off("data", onData);
      process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.reset}${ANSI.alternateOff}\r\x1b[2K`);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {}
      restoreChatKeypressListeners();
      try {
        rl?.resume?.();
      } catch {}
      resolve(value);
    };
    const pick = (index) => MODEL_OPTIONS[index]?.id || "";
    const onData = (buf) => {
      const s = buf.toString("utf8");
      if (s === "\u0003" || s === "q" || s === "Q" || s === "\x1b") {
        cleanup("");
        return;
      }
      const mouse = parseMouseSgr(s);
      if (mouse) {
        const hit = rows.find((r) => r.row === mouse.row);
        if (hit) cleanup(pick(hit.index));
        return;
      }
      if (s === "\x1b[A") {
        selectedIndex = Math.max(0, selectedIndex - 1);
        typed = "";
        render();
        return;
      }
      if (s === "\x1b[B") {
        selectedIndex = Math.min(MODEL_OPTIONS.length - 1, selectedIndex + 1);
        typed = "";
        render();
        return;
      }
      if (/^\d$/.test(s)) {
        typed = (typed + s).slice(0, 2);
        render();
        return;
      }
      if (s === "\b" || s === "\x7f") {
        typed = typed.slice(0, -1);
        render();
        return;
      }
      if (s === "\r" || s === "\n") {
        if (typed) {
          const model = modelByInput(typed);
          if (MODELS.includes(model)) {
            cleanup(model);
            return;
          }
          typed = "";
          render();
          return;
        }
        cleanup(pick(selectedIndex));
      }
    };

    try {
      rl?.pause?.();
    } catch {}
    suspendChatKeypressListeners();
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(`${ANSI.alternateOn}${ANSI.mouseOn}`);
    render();
    stdin.on("data", onData);
  });
}

async function chooseModelSetting(arg, rl) {
  const direct = modelByInput(arg);
  if (direct) {
    await updateSetting("model", direct);
    return;
  }
  const picked = await chooseModelMenu(rl);
  if (!picked) {
    console.log("모델 선택을 취소했습니다.");
    return;
  }
  await updateSetting("model", picked);
}

function terminalCharWidth(ch) {
  const cp = String(ch || "").codePointAt(0) || 0;
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff))
  ) return 2;
  return 1;
}

function displayWidth(value) {
  return Array.from(String(value || "")).reduce((sum, ch) => sum + terminalCharWidth(ch), 0);
}

function fitDisplay(value, maxWidth) {
  const text = String(value || "");
  if (displayWidth(text) <= maxWidth) return text;
  const suffix = "...";
  const target = Math.max(0, maxWidth - suffix.length);
  let out = "";
  let width = 0;
  for (const ch of Array.from(text)) {
    const next = terminalCharWidth(ch);
    if (width + next > target) break;
    out += ch;
    width += next;
  }
  return `${out}${suffix}`;
}

function padDisplay(value, width) {
  const fitted = fitDisplay(value, width);
  return `${fitted}${" ".repeat(Math.max(0, width - displayWidth(fitted)))}`;
}

function settingsPanelRows(draft) {
  const modelLabel = MODEL_OPTIONS.find((item) => item.id === draft.model)?.label || draft.model || "-";
  const outputLevel = inferLevel(OUTPUT_PRESETS, draft.maxOutputTokens);
  const reasoningPresets = getReasoningPresets(draft.model);
  const reasoningLevel = inferLevel(reasoningPresets, draft.maxReasoningTokens);
  return [
    { key: "model", group: "AI 응답", label: "모델", value: modelLabel, kind: "choice" },
    { key: "maxOutputTokens", group: "AI 응답", label: "출력 길이", value: `${LEVEL_LABEL[outputLevel]} (${OUTPUT_PRESETS[outputLevel]}자)`, kind: "choice" },
    { key: "maxReasoningTokens", group: "AI 응답", label: "추론", value: `${reasoningLevelLabel(draft.model, reasoningLevel)} (${reasoningPresets[reasoningLevel]} 토큰)`, kind: "choice" },
    { key: "personaName", group: "페르소나", label: "이름", value: draft.personaName || (draft._personaDisplayName ? `${draft._personaDisplayName} (기본)` : "(미지정)"), kind: "text" },
    { key: "personaAge", group: "페르소나", label: "나이", value: Number(draft.personaAge) > 0 ? String(draft.personaAge) : "(미지정)", kind: "number" },
    { key: "personaGender", group: "페르소나", label: "성별", value: draft.personaGender || "(미지정)", kind: "choice" },
    { key: "personaInfo", group: "페르소나", label: "상세 정보", value: oneLine(draft.personaInfo || "(미지정)", 80), kind: "text" },
    { key: "userNote", group: "추가 지시", label: "유저 노트", value: oneLine(draft.userNote || "(없음)", 80), kind: "text" },
    { key: "save", group: "완료", label: "저장", value: "변경사항 적용", kind: "save" },
    { key: "cancel", group: "완료", label: "취소", value: "변경사항 버리기", kind: "cancel" },
  ];
}

function renderSettingsPanel(draft, selectedIndex, dirty, notice) {
  clearScreen();
  const width = Math.max(48, Math.min(96, Number(process.stdout.columns || 80)));
  const innerWidth = width - 2;
  const border = `+${"-".repeat(innerWidth)}+`;
  const lines = [];
  const hitRows = [];
  const rows = settingsPanelRows(draft);
  const inside = (text, style = "") => `${style}|${padDisplay(text, innerWidth)}|${ANSI.reset}`;

  lines.push(`${ANSI.bold}${ANSI.title}${border}${ANSI.reset}`);
  lines.push(inside(`  ARCA DOS 설정 패널${dirty ? "  * 저장 안 됨" : ""}`, ANSI.bold + ANSI.title));
  lines.push(`${ANSI.title}${border}${ANSI.reset}`);

  let lastGroup = "";
  rows.forEach((row, index) => {
    if (row.group !== lastGroup) {
      if (lastGroup) lines.push(inside(""));
      lines.push(inside(`  [${row.group}]`, ANSI.soft));
      lastGroup = row.group;
    }
    const rowNo = lines.length + 1;
    const marker = index === selectedIndex ? ">" : " ";
    const action = row.kind === "choice" ? "[변경]" : row.kind === "save" ? "[저장]" : row.kind === "cancel" ? "[닫기]" : "[입력]";
    const valueWidth = Math.max(16, innerWidth - 29);
    const plain = `${marker} ${String(index + 1).padStart(2, " ")}. ${action} ${padDisplay(row.label, 11)} ${fitDisplay(row.value, valueWidth)}`;
    const style = index === selectedIndex ? ANSI.reverse + ANSI.dialogue : ANSI.dialogue;
    lines.push(inside(plain, style));
    hitRows.push({ row: rowNo, index });
  });

  lines.push(`${ANSI.title}${border}${ANSI.reset}`);
  lines.push(inside("  F2 설정  |  방향키 이동  |  Enter/클릭 수정  |  S 저장  |  Esc 닫기", ANSI.gray));
  if (notice) lines.push(inside(`  ${fitDisplay(notice, innerWidth - 4)}`, ANSI.soft));
  lines.push(`${ANSI.bold}${ANSI.title}${border}${ANSI.reset}`);
  process.stdout.write(`${ANSI.hideCursor}${lines.join("\n")}\n`);
  return { rows, hitRows };
}

async function chooseSettingsPanelAction(rl, draft, selectedIndex, dirty, notice) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return { type: "cancel", selectedIndex };
  }

  return await new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let rendered = null;
    let currentIndex = Math.max(0, Math.min(settingsPanelRows(draft).length - 1, selectedIndex));
    const render = () => {
      rendered = renderSettingsPanel(draft, currentIndex, dirty, notice);
    };
    const cleanup = (result) => {
      stdin.off("data", onData);
      process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.reset}`);
      try { stdin.setRawMode(Boolean(wasRaw)); } catch {}
      try { rl?.resume?.(); } catch {}
      resolve({ ...result, selectedIndex: currentIndex });
    };
    const activate = (direction = 1) => {
      const row = rendered?.rows?.[currentIndex];
      if (!row) return;
      if (row.kind === "save") cleanup({ type: "save" });
      else if (row.kind === "cancel") cleanup({ type: "cancel" });
      else cleanup({ type: "edit", row, direction });
    };
    const onData = (buf) => {
      const s = buf.toString("utf8");
      if (s === "\u0003" || s === "q" || s === "Q" || s === "\x1b") return cleanup({ type: "cancel" });
      if (s === "s" || s === "S") return cleanup({ type: "save" });
      const mouse = parseMouseSgr(s);
      if (mouse) {
        const hit = rendered?.hitRows?.find((item) => item.row === mouse.row);
        if (hit) {
          currentIndex = hit.index;
          activate(1);
        }
        return;
      }
      if (s === "\x1b[A") {
        currentIndex = (currentIndex - 1 + rendered.rows.length) % rendered.rows.length;
        render();
      } else if (s === "\x1b[B" || s === "\t") {
        currentIndex = (currentIndex + 1) % rendered.rows.length;
        render();
      } else if (s === "\x1b[D") {
        activate(-1);
      } else if (s === "\x1b[C" || s === "\r" || s === "\n") {
        activate(1);
      }
    };

    try { rl?.pause?.(); } catch {}
    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(ANSI.mouseOn);
    render();
    stdin.on("data", onData);
  });
}

function cycleSettingsPanelValue(draft, row, direction) {
  const step = direction < 0 ? -1 : 1;
  if (row.key === "model") {
    const currentModel = String(draft.model || "");
    const index = Math.max(0, MODEL_OPTIONS.findIndex((item) => item.id === currentModel));
    const nextIndex = (index + step + MODEL_OPTIONS.length) % MODEL_OPTIONS.length;
    const nextModel = MODEL_OPTIONS[nextIndex].id;
    draft.maxReasoningTokens = reasoningTokensForModelChange(
      currentModel,
      nextModel,
      draft.maxReasoningTokens
    );
    draft.model = nextModel;
    return `모델: ${MODEL_OPTIONS[nextIndex].label}`;
  }
  if (row.key === "maxOutputTokens") {
    const levels = Object.keys(OUTPUT_PRESETS);
    const current = inferLevel(OUTPUT_PRESETS, draft.maxOutputTokens);
    const index = Math.max(0, levels.indexOf(current));
    const next = levels[(index + step + levels.length) % levels.length];
    draft.maxOutputTokens = OUTPUT_PRESETS[next];
    return `출력 길이: ${LEVEL_LABEL[next]}`;
  }
  if (row.key === "maxReasoningTokens") {
    const presets = getReasoningPresets(draft.model);
    const levels = Object.keys(presets);
    const current = inferLevel(presets, draft.maxReasoningTokens);
    const index = Math.max(0, levels.indexOf(current));
    const next = levels[(index + step + levels.length) % levels.length];
    draft.maxReasoningTokens = presets[next];
    return `추론: ${reasoningLevelLabel(draft.model, next)}`;
  }
  if (row.key === "personaGender") {
    const values = ["", "남", "여"];
    const index = Math.max(0, values.indexOf(String(draft.personaGender || "")));
    draft.personaGender = values[(index + step + values.length) % values.length];
    return `성별: ${draft.personaGender || "미지정"}`;
  }
  return "";
}

async function editSettingsPanelValue(rl, draft, row) {
  const labels = {
    personaName: "페르소나 이름",
    personaAge: "나이",
    personaInfo: "페르소나 상세 정보",
    userNote: "유저 노트",
  };
  const label = labels[row.key] || row.label;
  const current = String(draft[row.key] || "");
  clearScreen();
  hr(`설정 입력 - ${label}`);
  console.log(`현재 값: ${current || "(비어 있음)"}`);
  console.log(`${ANSI.gray}Enter는 기존 값 유지, /clear는 값 비우기${ANSI.reset}`);
  const answer = String(await rl.question(`${label}> `) || "").trim();
  if (!answer) return `${label}: 기존 값 유지`;
  if (answer.toLowerCase() === "/clear") {
    draft[row.key] = row.kind === "number" ? 0 : "";
    return `${label}: 비움`;
  }
  if (row.kind === "number") {
    const value = Number(answer);
    if (!Number.isFinite(value) || value < 0 || value > 999) return "나이는 0~999 사이 숫자로 입력하세요.";
    draft[row.key] = Math.floor(value);
  } else {
    draft[row.key] = answer;
  }
  return `${label}: 입력 완료`;
}

async function openSettingsPanel(rl) {
  const st = await loadSettings({ force: true });
  if (!st) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const draft = { ...st, chatId: state.chatId };
  Object.defineProperty(draft, "_personaDisplayName", {
    value: getPromptDisplayName(),
    enumerable: false,
  });
  let selectedIndex = 0;
  let dirty = false;
  let notice = "";
  let done = false;
  let finalMessage = "";

  process.stdout.write(ANSI.alternateOn);
  try {
    while (!done) {
      const action = await chooseSettingsPanelAction(rl, draft, selectedIndex, dirty, notice);
      selectedIndex = action.selectedIndex;
      if (action.type === "cancel") {
        done = true;
        break;
      }
      if (action.type === "save") {
        const json = await apiJson("/api/chat/settings", {
          method: "POST",
          body: JSON.stringify(draft),
        });
        applySettings(json && json.settings ? json.settings : null);
        finalMessage = "설정 저장됨.";
        done = true;
        break;
      }
      if (action.type === "edit" && action.row) {
        if (action.row.kind === "choice") {
          notice = cycleSettingsPanelValue(draft, action.row, action.direction);
        } else {
          notice = await editSettingsPanelValue(rl, draft, action.row);
        }
        dirty = true;
      }
    }
  } finally {
    process.stdout.write(`${ANSI.mouseOff}${ANSI.showCursor}${ANSI.reset}${ANSI.alternateOff}\r\x1b[2K`);
  }
  if (finalMessage) console.log(finalMessage);
}

async function startupPresetLauncher() {
  const presets = listPresets(30);
  state.recentPresets = presets;
  while (true) {
    const choice = await choosePresetAction(presets);
    if (!choice) return false;
    if (choice.action === "continue" && choice.preset.latestChatId) {
      const picked = await chooseContinueChat(choice.preset);
      if (!picked) return false;
      if (picked.back) continue;
      await openChat(picked.chat.id);
      return true;
    }
    await createChat(choice.preset.id);
    return true;
  }
}

async function goBackToPreviousPage(rl) {
  const prevChatId = state.chatId;
  const prevSettings = state.settings;
  process.stdout.write("\n[이전 화면]\n");
  try { rl?.pause?.(); } catch {}
  const opened = await startupPresetLauncher();
  try { rl?.resume?.(); } catch {}

  if (!opened) {
    state.chatId = prevChatId;
    state.settings = prevSettings;
    if (state.chatId) await loadSettings().catch(() => null);
    console.log(state.chatId ? "원래 채팅으로 돌아왔습니다." : "선택을 취소했습니다.");
  }
}

async function selectInitialChat() {
  if (state.chatId) {
    await loadSettings().catch(() => null);
    return;
  }
  const chats = listChats(1);
  if (chats[0]) {
    state.chatId = chats[0].id;
    await loadSettings().catch(() => null);
  }
}

async function showHistory(limit = 20) {
  if (!state.chatId) {
    console.log("열린 채팅이 없습니다. /chats 또는 /new 를 사용하세요.");
    return;
  }
  const json = await apiJson(
    `/api/chat/history?chatId=${encodeURIComponent(state.chatId)}&limit=${Math.max(1, Math.min(200, limit))}`
  );
  const messages = Array.isArray(json && json.messages) ? json.messages : [];
  hr(`최근 ${messages.length}개`);
  for (const msg of messages) {
    const content = textOnly(msg.content || "");
    if (!content) continue;
    console.log(`[${roleLabel(msg.role)}] ${fmtTime(msg.createdAt)}`);
    printWrapped(content, { defaultPlainNarration: msg.role !== "user" });
    console.log("");
  }
}

async function createChat(indexOrId) {
  let presetId = String(indexOrId || "").trim();

  // 인자 없으면 사용법 안내 + 작품 목록.
  if (!presetId) {
    console.log("사용법: /new <작품번호>  또는  /new <presetId>");
    console.log("");
    printPresets(listPresets(30));
    return;
  }

  const n = Number(presetId);
  if (Number.isInteger(n) && n >= 1) {
    if (!state.recentPresets.length) state.recentPresets = listPresets(30);
    const preset = state.recentPresets[n - 1];
    if (!preset) throw new Error("작품 번호를 찾지 못했습니다.");
    presetId = preset.id;
  }
  const json = await apiJson("/api/chat/create", {
    method: "POST",
    body: JSON.stringify({ presetId }),
  });
  state.chatId = String(json && json.chatId ? json.chatId : "");
  await loadSettings().catch(() => null);
  console.log(`새 채팅을 열었습니다: ${state.chatId}`);
  await showHistory(8);
  console.log(`${ANSI.gray}F2 : 설정 패널${ANSI.reset}`);
}

async function openChat(indexOrId) {
  let chatId = String(indexOrId || "").trim();

  // 인자 없으면 사용법 안내 + 최근 채팅 목록.
  if (!chatId) {
    console.log("사용법: /open <번호>  또는  /open <chatId>");
    console.log("");
    printChats(listChats(15));
    return;
  }

  const n = Number(chatId);
  if (Number.isInteger(n) && n >= 1) {
    if (!state.recentChats.length) state.recentChats = listChats(15);
    const chat = state.recentChats[n - 1];
    if (!chat) throw new Error("채팅 번호를 찾지 못했습니다.");
    chatId = chat.id;
  }

  // (안전망) 직접 chatId를 입력했을 때 다른 계정의 채팅이면 서버 API가 404로 거부한다.
  // dos는 같은 DB에서 직접 읽으므로 ownership을 미리 확인해 친절하게 알려준다.
  const ownerRow = dbGet(
    `SELECT COALESCE(userEmail, '') AS userEmail FROM chats WHERE id=?`,
    [chatId]
  );
  if (!ownerRow) {
    throw new Error(`채팅을 찾지 못했습니다: ${chatId}`);
  }
  const owner = String(ownerRow.userEmail || "").trim().toLowerCase();
  if (owner && owner !== LOCAL_USER_EMAIL) {
    throw new Error(
      `이 채팅은 다른 계정(${owner}) 소유입니다. 현재 계정(${LOCAL_USER_EMAIL})에서는 열 수 없어요.\n` +
      `LOCAL_USER_EMAIL 환경변수를 바꾸거나, /chats 목록의 번호로 본인 채팅을 선택하세요.`
    );
  }

  state.chatId = chatId;
  await loadSettings().catch(() => null);
  console.log(`채팅을 열었습니다: ${state.chatId}`);
  // (수정) 이전 12개만 보여줘서 "방금 한 메시지가 안 보인다"는 혼란이 있었음 → 40개로 늘림.
  // 더 보고 싶으면 /history 200 까지 확장 가능.
  await showHistory(40);
  console.log(`${ANSI.gray}F2 : 설정 패널${ANSI.reset}`);
}

async function updateSetting(field, value) {
  const st = await loadSettings();
  if (!st) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const next = { ...st, chatId: state.chatId };
  const v = String(value || "").trim();

  if (field === "model") {
    if (!v) {
      hr("모델");
      console.log(`현재: ${st.model || "-"}`);
      console.log("");
      console.log("지원 모델:");
      for (const m of MODELS) console.log(`  ${m}`);
      console.log("");
      console.log("변경: /model <모델명>  (또는 /model 로 인터랙티브 선택)");
      return;
    }
    if (!MODELS.includes(v)) {
      console.log(`지원 모델: ${MODELS.join(", ")}`);
      return;
    }
    next.maxReasoningTokens = reasoningTokensForModelChange(
      st.model,
      v,
      st.maxReasoningTokens
    );
    next.model = v;
  } else if (field === "maxOutputTokens") {
    if (!v) {
      const cur = inferLevel(OUTPUT_PRESETS, st.maxOutputTokens);
      hr("출력 길이");
      console.log(`현재: ${LEVEL_LABEL[cur]} (${OUTPUT_PRESETS[cur]}자 목표)`);
      console.log("");
      console.log("단계별 글자 목표:");
      console.log(`  LOW  → ${OUTPUT_PRESETS.low}자`);
      console.log(`  MID  → ${OUTPUT_PRESETS.middle}자`);
      console.log(`  HIGH → ${OUTPUT_PRESETS.high}자`);
      console.log("");
      console.log("변경: /output low   |   /output mid   |   /output high");
      return;
    }
    const lv = parseLevelArg(v);
    if (!lv) {
      console.log("/output low | mid | high  중 하나로 입력하세요.");
      return;
    }
    next.maxOutputTokens = OUTPUT_PRESETS[lv];
  } else if (field === "maxReasoningTokens") {
    const presets = getReasoningPresets(next.model || st.model);
    const zeroAvailable = Object.prototype.hasOwnProperty.call(presets, "zero");
    const reasonCommand = { zero: "fast", low: "low", middle: "mid", high: "high" };
    const availableCommandText = Object.keys(presets).map((key) => reasonCommand[key]).filter(Boolean).join(" | ");
    if (!v) {
      const cur = inferLevel(presets, st.maxReasoningTokens);
      hr("추론 토큰");
      console.log(`현재: ${reasoningLevelLabel(next.model || st.model, cur)} (${presets[cur]} 토큰)`);
      console.log("");
      console.log(`모델 '${next.model || st.model}' 단계별 토큰:`);
      for (const [key, tokens] of Object.entries(presets)) {
        const label = reasoningLevelLabel(next.model || st.model, key).padEnd(4, " ");
        const detail = key === "zero" ? "공식 최저 low" : `${tokens} 토큰`;
        console.log(`  ${label} → ${detail}`);
      }
      console.log("");
      console.log(`변경: /reason ${availableCommandText}`);
      const isGemini3Pro = isGemini3ProFamilyModel(next.model || st.model);
      if (isGemini3Pro) {
        console.log("");
        console.log("※ Gemini 3.x Pro는 단계만 받고 실제 토큰은 모델이 자율 결정. 설정값과 실제 사용량이 다를 수 있음.");
      }
      return;
    }
    const lv = parseLevelArg(v, zeroAvailable);
    if (!lv || !Object.prototype.hasOwnProperty.call(presets, lv)) {
      console.log(`/reason ${availableCommandText} 중 하나로 입력하세요.`);
      return;
    }
    next.maxReasoningTokens = presets[lv];
  }

  const json = await apiJson("/api/chat/settings", {
    method: "POST",
    body: JSON.stringify(next),
  });
  applySettings(json && json.settings ? json.settings : null);
  await showSettings();
}

// (페르소나) 페르소나 보기/변경 명령.
// - /persona               : 현재 정보 표시 + 변경 방법 안내
// - /persona name 지훈     : 이름만 변경
// - /persona age 22        : 나이
// - /persona gender 남     : 성별
// - /persona info 키 178...: 상세 설명 (한 줄 입력. 줄바꿈은 \n 으로 입력)
// - /persona edit          : 대화형 4단계 입력 (각 항목 Enter 시 기존값 유지)
async function personaCommand(rl, arg) {
  const st = await loadSettings();
  if (!st) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const a = String(arg || "").trim();
  if (!a) {
    hr("페르소나");
    console.log(`이름   : ${st.personaName || "(미지정)"}`);
    console.log(`나이   : ${st.personaAge || "(미지정)"}`);
    console.log(`성별   : ${st.personaGender || "(미지정)"}`);
    console.log(`정보   : ${st.personaInfo || "(미지정)"}`);
    console.log("");
    console.log("변경:");
    console.log("  /persona name 지훈");
    console.log("  /persona age 22");
    console.log("  /persona gender 남");
    console.log("  /persona info 키 178, 컴공과 22살. 카페 라떼 좋아함.");
    console.log("  /persona edit                (대화형으로 4가지 한꺼번에 입력)");
    return;
  }

  const [subcmdRaw, ...restArr] = a.split(/\s+/);
  const sub = String(subcmdRaw || "").toLowerCase();
  const rest = restArr.join(" ").trim();

  if (sub === "edit") {
    const cur = {
      personaName: String(st.personaName || ""),
      personaAge: String(st.personaAge || ""),
      personaGender: String(st.personaGender || ""),
      personaInfo: String(st.personaInfo || ""),
    };
    const ask = async (label, current) => {
      const promptStr = `${label} [${current || "비어있음"}] (Enter면 유지): `;
      const ans = await rl.question(promptStr);
      const s = String(ans || "").trim();
      return s || current;
    };
    const name = await ask("이름", cur.personaName);
    const ageStr = await ask("나이(숫자)", cur.personaAge);
    const gender = await ask("성별", cur.personaGender);
    const info = await ask("정보", cur.personaInfo);

    const ageNum = Number(ageStr);
    const next = {
      ...st,
      chatId: state.chatId,
      personaName: name,
      personaAge: Number.isFinite(ageNum) && ageNum > 0 ? Math.floor(ageNum) : 0,
      personaGender: gender,
      personaInfo: info,
    };
    const json = await apiJson("/api/chat/settings", {
      method: "POST",
      body: JSON.stringify(next),
    });
    applySettings(json && json.settings ? json.settings : null);
    console.log("페르소나 저장 완료.");
    await showSettings();
    return;
  }

  if (!["name", "age", "gender", "info"].includes(sub)) {
    throw new Error("/persona name|age|gender|info|edit  형식으로 입력하세요. 인자 없이 /persona 만 입력하면 현재 정보 표시.");
  }

  const next = { ...st, chatId: state.chatId };
  if (sub === "name") next.personaName = rest;
  else if (sub === "age") {
    const n = Number(rest);
    if (!Number.isFinite(n) || n < 0) throw new Error("나이는 0 이상의 숫자로 입력하세요.");
    next.personaAge = Math.floor(n);
  } else if (sub === "gender") next.personaGender = rest;
  else if (sub === "info") next.personaInfo = rest;

  const json = await apiJson("/api/chat/settings", {
    method: "POST",
    body: JSON.stringify(next),
  });
  applySettings(json && json.settings ? json.settings : null);
  console.log(`페르소나 ${sub} 저장 완료.`);
}

async function showMemory() {
  if (!state.chatId) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const json = await apiJson(`/api/chat/memory/summary?chatId=${encodeURIComponent(state.chatId)}`);
  hr("장기기억");
  const meta = json && json.meta ? json.meta : {};
  const policy = json && json.policy ? json.policy : {};
  console.log(`요약 완료 턴: ${meta.summarizedEndTurn || 0} / 요약 글자: ${meta.recentSummaryChars || 0} / 턴당: ${policy.perTurnChars || "-"}`);
  console.log("");
  printWrapped(json && json.summary ? json.summary : "(비어 있음)");
}

async function showCharacters(nameOrIndex = "") {
  if (!state.chatId) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const json = await apiJson(`/api/chat/characters?chatId=${encodeURIComponent(state.chatId)}&includeMemories=0`);
  const chars = Array.isArray(json && json.characters) ? json.characters : [];
  hr("캐릭터 등록부");
  if (!chars.length) {
    console.log("등록된 캐릭터가 없습니다. /addchar 이름 으로 추가하세요.");
    return;
  }
  chars.forEach((ch, i) => {
    const enabled = ch.enabled === false ? "OFF" : "ON";
    console.log(`${String(i + 1).padStart(2, " ")}. ${ch.name} [${enabled}] 기록 ${ch.memoryCount || 0}개`);
  });

  const sel = String(nameOrIndex || "").trim();
  if (!sel) return;
  let picked = null;
  const n = Number(sel);
  if (Number.isInteger(n) && n >= 1) picked = chars[n - 1];
  else picked = chars.find((c) => String(c.name || "") === sel);
  if (!picked) throw new Error("캐릭터를 찾지 못했습니다.");

  const detail = await apiJson(
    `/api/chat/characters?chatId=${encodeURIComponent(state.chatId)}&rosterId=${encodeURIComponent(picked.id)}&limit=5&offset=0`
  );
  console.log("");
  hr(`${picked.name} 기록`);
  const memories = Array.isArray(detail && detail.memories) ? detail.memories : [];
  if (!memories.length) {
    console.log("저장된 만남 기록이 없습니다.");
    return;
  }
  for (const mem of memories) {
    console.log(`${mem.turnNo}턴: ${textOnly(mem.summary || "")}`);
  }
  if (detail.hasMore) console.log(`더 있음: ${detail.nextOffset}/${detail.total}`);
}

async function addCharacter(name) {
  if (!state.chatId) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const clean = String(name || "").trim();
  if (!clean) {
    console.log("사용법: /addchar <캐릭터 이름>");
    console.log("");
    console.log("예) /addchar 서연");
    console.log("    /addchar 민재");
    console.log("");
    console.log("이름만 등록되며 상세 프로필은 등록 후 별도 도구로 채우거나");
    console.log("채팅 내 자동 탐지로 (자동 탐지) 프리픽스가 붙어 채워집니다.");
    return;
  }
  const json = await apiJson("/api/chat/characters", {
    method: "POST",
    body: JSON.stringify({ chatId: state.chatId, name: clean }),
  });
  console.log(`등록 완료: ${json && json.character ? json.character.name : clean}`);
}

async function refreshMemory(mode = "all") {
  if (!state.chatId) throw new Error("열린 채팅이 없습니다.");
  console.log("기억 갱신 중...");
  await apiJson("/api/chat/memory/refresh", {
    method: "POST",
    body: JSON.stringify({ chatId: state.chatId, mode, allowBadOutputSave: true }),
  });
  console.log("기억 갱신 완료");
}

// (삭제) 최근 user + assistant 한 쌍을 함께 삭제. 웹의 "휴지통" 동작과 동일.
// - /delete : 가장 최근 assistant 메시지 + 직전 user 메시지 삭제
// - /delete N : 최근 N 쌍 삭제 (기본 1)
async function deleteRecent(arg) {
  if (!state.chatId) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const n = Math.max(1, Math.min(50, Number(String(arg || "").trim()) || 1));

  const messages = dbAll(
    `SELECT id, role, createdAt FROM messages
     WHERE chatId=?
     ORDER BY createdAt DESC, id DESC
     LIMIT 200`,
    [state.chatId]
  );
  if (!messages.length) {
    console.log("삭제할 메시지가 없습니다.");
    return;
  }

  // 짝 찾기: 마지막 assistant + 그 직전 user 한 쌍 = 1개 묶음
  // 묶음 N개 만들기. messages는 DESC 순.
  const pairs = [];
  let i = 0;
  while (i < messages.length && pairs.length < n) {
    const m = messages[i];
    const isAsst = m.role === "assistant" || m.role === "model";
    if (isAsst) {
      const idsToDelete = [m.id];
      const prev = messages[i + 1];
      if (prev && prev.role === "user") {
        idsToDelete.push(prev.id);
        i += 2;
      } else {
        i += 1;
      }
      pairs.push(idsToDelete);
    } else if (m.role === "user") {
      // 사용자가 보낸 후 응답 못 받은 user 메시지만 있는 경우
      pairs.push([m.id]);
      i += 1;
    } else {
      i += 1;
    }
  }

  if (!pairs.length) {
    console.log("삭제할 짝을 찾지 못했습니다.");
    return;
  }

  const flatIds = pairs.flat();
  let deleted = 0;
  for (const id of flatIds) {
    try {
      const res = await fetch(
        `${API_BASE}/api/chat/message?messageId=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      if (res.ok) deleted += 1;
    } catch {
      // continue
    }
  }
  console.log(`삭제 완료: ${pairs.length}쌍 (${deleted}개 메시지)`);
  await showHistory(40);
}

async function refreshCharacterMemory(assistantMessageId) {
  if (!state.chatId) return { ok: false, skipped: true, saved: 0 };
  try {
    const json = await apiJson("/api/chat/characters/refresh", {
      method: "POST",
      body: JSON.stringify({ chatId: state.chatId, assistantMessageId: assistantMessageId || "" }),
    });
    // (변경) 콘솔 알림 제거 — 백그라운드 저장은 항상 silent.
    return { ok: true, skipped: Boolean(json && json.skipped), saved: Number((json && json.saved) || 0) };
  } catch {
    // 캐릭터 등록부가 비어 있으면 조용히 넘어간다.
    return { ok: false, skipped: true, saved: 0 };
  }
}

// (수동 backfill) 현재 chat에서 최근 N개 assistant 메시지에 대해
// chat_character_turn_memories를 재평가 → strict 가드 통과한 turn만 저장.
// - 자동 탐지 직후의 자동 backfill과 동일한 라우트 사용
// - 이미 등록된 캐릭터의 0개 누락(직접 대화 turn이 등록 이전에 있던 경우)을 메우기 위함
async function backfillCharacters(arg) {
  if (!state.chatId) {
    console.log("열린 채팅이 없습니다.");
    return;
  }
  const requested = Number(String(arg || "").trim());
  const n = Math.max(1, Math.min(30, Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 6));

  const rows = dbAll(
    `SELECT id FROM messages
     WHERE chatId=? AND (role='assistant' OR role='model')
     ORDER BY createdAt DESC, id DESC
     LIMIT ?`,
    [state.chatId, n]
  );
  if (!rows.length) {
    console.log("응답 메시지가 없습니다.");
    return;
  }

  console.log(`최근 ${rows.length}턴 캐릭터 기록 backfill 중... (LLM 호출 ${rows.length}회)`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    rows.map((r) =>
      apiJson("/api/chat/characters/refresh", {
        method: "POST",
        body: JSON.stringify({ chatId: state.chatId, assistantMessageId: String(r.id || "") }),
      })
    )
  );
  let saved = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value && typeof r.value === "object") {
      saved += Math.max(0, Number(r.value.saved || 0));
      if (r.value.skipped) skipped += 1;
    } else {
      failed += 1;
    }
  }
  const ms = Date.now() - t0;
  console.log(`backfill 완료: ${ms}ms / 저장 ${saved}건 / 스킵 ${skipped} / 실패 ${failed}`);
  await showCharacters("");
}

async function postSend(text) {
  if (!state.chatId) {
    throw new Error("열린 채팅이 없습니다. /chats, /open, /presets, /new 를 먼저 사용하세요.");
  }
  const st = await loadSettings().catch(() => null);
  const runtime = st
    ? {
        model: st.model,
        maxOutputTokens: st.maxOutputTokens,
        maxReasoningTokens: st.maxReasoningTokens,
        keepUserTurns: st.memoryFrom,
        perTurnChars: st.summaryLength,
      }
    : undefined;
  const modelName = String(runtime?.model || st?.model || "").trim();
  const wantStream = isGemini3ProFamilyModel(modelName);

  console.log("");
  hr("응답");
  const started = Date.now();
  let status = startResponseStatus(started);
  const timing = {
    model: modelName,
    startedAt: started,
    headerAt: 0,
    firstSignalAt: 0,
    firstOutputAt: 0,
    doneAt: 0,
    responseEndAt: 0,
    memoryMs: null,
    characterMs: null,
    usage: null,
  };
  let res;
  try {
    res = await fetch(`${API_BASE}/api/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: state.chatId,
        userText: text,
        runtime,
        includeSuggestions: false,
        stream: wantStream,
      }),
      // Ctrl+C 취소 지원 (stream 응답 도중에도 abort됨)
      signal: state.activeController ? state.activeController.signal : undefined,
    });
  } catch (err) {
    status?.stop(true);
    status = null;
    throw err;
  }
  timing.headerAt = Date.now();

  if (!res.ok) {
    status?.stop(true);
    status = null;
    const errText = await res.text().catch(() => "");
    throw new Error(errText || `HTTP ${res.status}`);
  }

  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  let doneObj = null;
  let printed = "";

  if (ct.includes("application/x-ndjson") && res.body && typeof res.body.getReader === "function") {
    // (2026-07) 서버가 gemini-3-pro 실시간 델타를 다시 보내므로,
    // fence/색상 안전을 위해 줄·펜스 단위 게이트 렌더러로 정리한 뒤,
    // 터미널 페이서로 몇 글자씩 흘려보내 자연스러운 타이핑 체감을 만든다.
    // (렌더러=정확성 담당, 페이서=연출 담당)
    const pacer = createTerminalPacer((s) => process.stdout.write(s));
    pacer.onFirstEmit(() => {
      if (!timing.firstOutputAt) timing.firstOutputAt = Date.now();
      status?.stop(true);
      status = null;
    });
    const renderer = createStreamRenderer((s) => pacer.push(s));
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let idx = -1;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let obj = null;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (!timing.firstSignalAt) timing.firstSignalAt = Date.now();
          if (obj.type === "delta") {
            renderer.push(obj.text || "");
          } else if (obj.type === "ping") {
            // keep-alive ping: the status line already shows elapsed time.
          } else if (obj.type === "done") {
            timing.doneAt = Date.now();
            doneObj = obj;
          } else if (obj.type === "error") {
            status?.stop(true);
            status = null;
            throw new Error(String(obj.error || "stream error"));
          }
        }
      }
      // 스트림 종료: 보류분(마지막 미완 줄/미닫힘 fence)을 렌더러→페이서로 넘기고,
      // 남은 잔량은 빠른 타이핑 속도로 마저 출력한다 (통짜 덤프 방지)
      renderer.finish();
      await pacer.drain();
    } catch (e) {
      // 취소/네트워크 오류: 페이서 즉시 정지 (잔량 파기 후 상위에서 오류 처리)
      pacer.stop();
      throw e;
    }
    printed = renderer.printedText();
  } else {
    doneObj = await res.json();
    timing.firstSignalAt = timing.firstSignalAt || Date.now();
    timing.doneAt = timing.doneAt || Date.now();
  }

  const finalText = textOnly(doneObj && doneObj.assistant ? doneObj.assistant.content : "");
  status?.stop(true);
  status = null;
  if (finalText && !printed.trim()) {
    timing.firstOutputAt = timing.firstOutputAt || Date.now();
    printWrapped(finalText);
  } else if (printed && !printed.endsWith("\n")) {
    process.stdout.write("\n");
  }
  timing.responseEndAt = Date.now();
const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`\n[완료: ${elapsed}초]`);
  timing.usage = doneObj && doneObj.usage ? doneObj.usage : null;

  // (변경) 장기기억 갱신/캐릭터 기록 저장은 백그라운드로 분리한다.
  // - 사용자가 응답을 보자마자 바로 다음 입력을 할 수 있도록 await 하지 않는다.
  // - 완료/실패 메시지는 readline prompt 중에 들어올 수 있으므로 앞뒤 줄바꿈으로 분리.
  // - /time에 들어가는 memoryMs/characterMs/state.lastTiming은 백그라운드 완료 시점에 후속 갱신.
  const memoryRefresh = doneObj ? doneObj.memoryRefresh : null;
  const chatIdSnapshot = String(state.chatId || "");
  const assistantIdSnapshot = String((doneObj && doneObj.assistant && doneObj.assistant.id) || "");
  const runtimeSnapshot = memoryRefresh && memoryRefresh.runtime ? memoryRefresh.runtime : runtime || null;

  // 두 작업 모두 **완전히 조용히** 백그라운드 처리. 화면에 어떤 알림도 출력하지 않는다.
  // 타이밍 정보(timing.memoryMs / characterMs)는 /time 명령용으로만 후속 갱신.
  if (memoryRefresh && (memoryRefresh.shouldRefresh || memoryRefresh.mode)) {
    const memStart = Date.now();
    void (async () => {
      try {
        await fetch(`${API_BASE}/api/chat/memory/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: chatIdSnapshot,
            runtime: runtimeSnapshot,
            mode: memoryRefresh.mode || "all",
            allowBadOutputSave: true,
          }),
        });
      } catch {
        // silent
      } finally {
        const ms = Date.now() - memStart;
        timing.memoryMs = ms;
        if (state.lastTiming) state.lastTiming.memoryMs = ms;
      }
    })();
  }

  {
    const charStart = Date.now();
    void (async () => {
      try {
        await fetch(`${API_BASE}/api/chat/characters/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: chatIdSnapshot,
            assistantMessageId: assistantIdSnapshot || "",
          }),
        });
      } catch {
        // silent
      } finally {
        const ms = Date.now() - charStart;
        timing.characterMs = ms;
        if (state.lastTiming) state.lastTiming.characterMs = ms;
      }
    })();
  }

  const firstSignalAt = timing.firstSignalAt || timing.doneAt || timing.responseEndAt;
  const firstOutputAt = timing.firstOutputAt || timing.doneAt || timing.responseEndAt;
  const doneAt = timing.doneAt || timing.responseEndAt;
  state.lastTiming = {
    ...timing,
    responseMs: timing.responseEndAt - started,
    headerWaitMs: timing.headerAt ? timing.headerAt - started : null,
    firstSignalWaitMs: firstSignalAt ? firstSignalAt - started : null,
    firstOutputWaitMs: firstOutputAt ? firstOutputAt - started : null,
    receiveMs: firstOutputAt && doneAt ? Math.max(0, doneAt - firstOutputAt) : null,
    afterWorkMs:
      (typeof timing.memoryMs === "number" ? timing.memoryMs : 0) +
      (typeof timing.characterMs === "number" ? timing.characterMs : 0),
    totalWithAfterMs: Date.now() - started,
  };
  printTimingSummary(state.lastTiming);
}

function help() {
  hr("ARCA DOS CHAT — 명령어");
  console.log("");
  console.log(`${ANSI.bold}${ANSI.title}■ 채팅${ANSI.reset}`);
  console.log("  /chats        최근 채팅 목록");
  console.log("  /open         채팅 열기");
  console.log("  /presets      작품 목록");
  console.log("  /new          작품으로 새 채팅 시작");
  console.log("  /history      대화 보기");
  console.log("  /delete       최근 user+assistant 한 쌍 삭제");
  console.log("");
  console.log(`${ANSI.bold}${ANSI.title}■ 설정${ANSI.reset}`);
  console.log("  /panel        클릭 가능한 통합 설정 패널 (F2)");
  console.log("  /settings     모델/출력/추론 한눈에 보기");
  console.log("  /model        모델 선택");
  console.log("  /output       출력 길이 (LOW/MID/HIGH)");
  console.log("  /reason       추론 설정 (3.1 Pro: FAST/MID/HIGH)");
  console.log("  /persona      페르소나(주인공) 보기/설정");
  console.log("");
  console.log(`${ANSI.bold}${ANSI.title}■ 기억 / 캐릭터${ANSI.reset}`);
  console.log("  /memory       장기기억 보기");
  console.log("  /refresh      장기기억 강제 갱신");
  console.log("  /chars        캐릭터 등록부/기록 보기");
  console.log("  /addchar      캐릭터 수동 등록");
  console.log("  /backfillchars  최근 N턴 캐릭터 기록 재평가");
  console.log("");
  console.log(`${ANSI.bold}${ANSI.title}■ 기타${ANSI.reset}`);
  console.log("  /time         마지막 응답 세부 시간");
  console.log("  /clear        화면 지우기");
  console.log("  /exit         종료");
  console.log("");
  console.log(`${ANSI.gray}각 명령어를 인자 없이 그냥 입력하면 사용법/현재 상태를 보여줍니다.${ANSI.reset}`);
  console.log(`${ANSI.gray}줄임말: /cs /o /p /n /hi /set /md /out /rs /per /mem /ref /ch /ac /bf /cls /q${ANSI.reset}`);
  console.log(`${ANSI.gray}Ctrl+Z : 방금 user+assistant 한 쌍 삭제${ANSI.reset}`);
  console.log(`${ANSI.gray}Ctrl+C : 진행 중이면 취소, 입력 대기 중이면 이전 화면${ANSI.reset}`);
  console.log(`${ANSI.gray}F2     : 통합 설정 패널 열기${ANSI.reset}`);
}

async function handleCommand(line, rl) {
  const [cmdRaw, ...rest] = line.trim().split(/\s+/g);
  const cmd = String(cmdRaw || "").toLowerCase();
  const arg = rest.join(" ").trim();
  // 줄임말 alias는 각 분기에 OR로 묶어둔다. 충돌(예: /r 가 reason vs refresh)은 발생하지 않도록 검토 완료.
  if (cmd === "/help" || cmd === "/?") help();
  else if (cmd === "/chats" || cmd === "/cs") printChats(listChats(15));
  else if (cmd === "/open" || cmd === "/o") await openChat(arg);
  else if (cmd === "/presets" || cmd === "/p") printPresets(listPresets(30));
  else if (cmd === "/new" || cmd === "/n") await createChat(arg);
  else if (cmd === "/history" || cmd === "/hi" || cmd === "/hist") await showHistory(Number(arg) || 20);
  else if (cmd === "/panel" || cmd === "/ui" || cmd === "/config") await openSettingsPanel(rl);
  else if (cmd === "/settings" || cmd === "/set" || cmd === "/s") await showSettings();
  else if (cmd === "/model" || cmd === "/md") await chooseModelSetting(arg, rl);
  else if (cmd === "/time" || cmd === "/t") printTimingDetail();
  else if (cmd === "/output" || cmd === "/out") await updateSetting("maxOutputTokens", arg);
  else if (cmd === "/reason" || cmd === "/rs") await updateSetting("maxReasoningTokens", arg);
  else if (cmd === "/persona" || cmd === "/per") await personaCommand(rl, arg);
  else if (cmd === "/memory" || cmd === "/mem" || cmd === "/m") await showMemory();
  else if (cmd === "/refresh" || cmd === "/ref" || cmd === "/r") await refreshMemory(arg || "all");
  else if (cmd === "/chars" || cmd === "/ch" || cmd === "/c") await showCharacters(arg);
  else if (cmd === "/addchar" || cmd === "/ac") await addCharacter(arg);
  else if (cmd === "/backfillchars" || cmd === "/bf" || cmd === "/bc") await backfillCharacters(arg);
  else if (cmd === "/delete" || cmd === "/del") await deleteRecent(arg);
  else if (cmd === "/clear" || cmd === "/cls") clearScreen();
  else if (cmd === "/exit" || cmd === "/quit" || cmd === "/q" || cmd === "/x") return false;
  else console.log("모르는 명령어입니다. /help 를 입력하세요.");
  return true;
}

async function checkMode() {
  console.log(`폴더: ${ROOT}`);
  console.log(`내부 서버: ${API_BASE} ${await health() ? "OK" : "연결 안 됨"}`);
  console.log(`DB: ${fs.existsSync(DB_PATH) ? "OK" : "없음"}`);
  const chats = fs.existsSync(DB_PATH) ? listChats(5) : [];
  console.log(`최근 채팅: ${chats.length}개`);
  chats.forEach((chat, i) => console.log(`${i + 1}. ${chat.title} (${chat.messageCount}개)`));
}

async function main() {
  if (args.check) {
    await checkMode();
    return;
  }

  clearScreen();
  hr("ARCA DOS CHAT");
  console.log("브라우저 없이 텍스트만 표시합니다. 이미지는 콘솔에 표시하지 않습니다.");
  console.log(`내부 서버: ${API_BASE}`);
  console.log("");

  if (!(await health())) {
    console.log("내부 서버에 연결하지 못했습니다. run-dos.ps1로 실행했는지 확인해 주세요.");
    process.exit(1);
  }

  const launched = await startupPresetLauncher();
  if (!launched) {
    console.log("열린 채팅이 없습니다. /presets 후 /new 번호 로 시작하세요.");
  }
  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 100,
  });
  installPromptShortcuts(rl);

  try {
    while (true) {
      // 채팅 설정/전역 프로필에서 페르소나명을 즉시 반영한다.
      const promptName = getPromptDisplayName();
      const prompt = state.chatId
        ? `\n${promptName}> `
        : "\nARCA(채팅없음)> ";
      let lineRaw = "";
      state.shortcutAction = "";
      state.promptController = new AbortController();
      try {
        lineRaw = await rl.question(prompt, { signal: state.promptController.signal });
      } catch (err) {
        const action = state.shortcutAction;
        state.shortcutAction = "";
        if (err && err.name === "AbortError" && action === "delete") {
          process.stdout.write("\n");
          await deleteRecent("");
          continue;
        }
        if (err && err.name === "AbortError" && action === "back") {
          await goBackToPreviousPage(rl);
          continue;
        }
        if (err && err.name === "AbortError" && action === "settings") {
          process.stdout.write("\n");
          await openSettingsPanel(rl);
          continue;
        }
        if (err && err.name === "AbortError") continue;
        throw err;
      } finally {
        state.promptController = null;
      }
      const line = String(lineRaw || "").trim();
      if (!line) continue;

      // (요구) 입력한 줄을 narration(*...*) 회색 처리해서 다시 표시.
      // readline은 raw line을 그대로 echo하므로, 입력 직후 그 줄을 위로 올라가 clear하고
      // 색 적용한 버전으로 다시 출력한다.
      if (line.includes("*") && process.stdout.isTTY) {
        try {
          const promptStr = prompt.replace(/^\n+/, ""); // 줄바꿈 제외한 prompt 본문
          process.stdout.write("\x1b[1A\x1b[2K");
          process.stdout.write(`${promptStr}${colorNovelInline(line)}\n`);
        } catch {
          // 일부 TTY 환경에서 ANSI 이동이 실패하면 무시 (기능 영향 없음)
        }
      }

      // 이번 명령에 대한 abort scope. Ctrl+C 시 SIGINT handler가 이 controller를 abort한다.
      state.activeController = new AbortController();
      try {
        if (line.startsWith("/")) {
          const keep = await handleCommand(line, rl);
          if (!keep) break;
        } else {
          await postSend(line);
        }
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        // SIGINT/abort 케이스는 이미 handler에서 메시지를 출력했으니 중복 출력 안 함.
        if (err && err.name === "AbortError") {
          // silent
        } else if (/aborted|abortsignal|abort\s*error/i.test(msg)) {
          // silent
        } else {
          console.log(`오류: ${msg}`);
        }
      } finally {
        state.activeController = null;
      }
    }
  } finally {
    rl.close();
  }
  console.log("종료했습니다.");
}

// require()로 불러오면(렌더러 단위 테스트 등) main을 자동 실행하지 않는다.
// run-dos.ps1 → `node dos-chat.js` 직접 실행 경로는 기존과 동일하게 동작.
if (require.main === module) {
  main().catch((err) => {
    console.error(`오류: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

module.exports = {
  textOnly,
  colorNovelText,
  colorNovelInline,
  createStreamRenderer,
  createTerminalPacer,
  cycleSettingsPanelValue,
  displayWidth,
  fitDisplay,
  settingsPanelRows,
};
