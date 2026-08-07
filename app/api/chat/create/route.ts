import { NextResponse } from "next/server";
import { db, deleteChatData, incrementPresetChatCount } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";
import { randomUUID } from "crypto";
import { encryptIfPossible } from "@/lib/crypto";
import { DEFAULT_CHAT_MODEL } from "@/lib/models";

const MAX_CHATS_PER_PRESET_ON_NEW = 3;

function escapeHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tabRowsToHtml(rows: string[][]) {
  if (rows.length < 2) return rows.map((r) => r.join("\t")).join("\n");
  const cols = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => Array.from({ length: cols }, (_, i) => String(r[i] || "").trim()));
  const head = norm[0] || [];
  const body = norm.slice(1);
  const th = head.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const trs = body
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function convertTabTablesToHtml(text: string) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let group: string[] = [];

  const flush = () => {
    if (!group.length) return;
    if (group.length >= 2) {
      out.push(tabRowsToHtml(group.map((line) => line.split("\t"))));
    } else {
      out.push(...group);
    }
    group = [];
  };

  for (const line of lines) {
    const cols = line.split("\t");
    const isTableLine = cols.length >= 2 && cols.some((c) => c.trim());
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

function deleteChatCascade(chatId: string, userEmail: string) {
  deleteChatData(chatId);
  db.prepare(`DELETE FROM chats WHERE id=? AND userEmail=?`).run(chatId, userEmail);
}

function prunePresetChats(userEmail: string, presetId: string, keep: number) {
  const run = db.transaction((targetUserEmail: string, targetPresetId: string, keepCount: number) => {
    const rows = db
      .prepare(
        `SELECT id
         FROM chats
         WHERE presetId=? AND userEmail=?
         ORDER BY createdAt DESC, id DESC`
      )
      .all(targetPresetId, targetUserEmail) as Array<{ id: string }>;
    for (let i = keepCount; i < rows.length; i++) {
      const chatId = String(rows[i]?.id || "");
      if (!chatId) continue;
      deleteChatCascade(chatId, targetUserEmail);
    }
  });
  run(userEmail, presetId, keep);
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { presetId } = await req.json();

  if (!presetId) {
    return NextResponse.json({ error: "프리셋을 먼저 선택해 주세요." }, { status: 400 });
  }

  // 프리셋 접근 권한
  // - 공개(isPublic=1): 누구나 채팅 생성 가능
  // - 비공개(isPublic=0): 소유자(작성자) 또는 관리자만 가능
  const preset = db
    .prepare(
      `SELECT
        id,
        characterName,
        firstMessages,
        COALESCE(isPublic, 1) AS isPublic,
        COALESCE(NULLIF(userEmail, ''), NULLIF(ownerEmail, ''), '') AS ownerEmail
      FROM presets
      WHERE id=?`
    )
    .get(presetId) as any;

  if (!preset) {
    return NextResponse.json({ error: "선택한 프리셋을 찾지 못했습니다." }, { status: 404 });
  }

  const ownerEmail = String(preset?.ownerEmail || "").trim().toLowerCase();
  const viewerEmail = String(u.email || "").trim().toLowerCase();
  const isOwner = !!ownerEmail && ownerEmail === viewerEmail;
  const isAdmin = isAdminEmail(viewerEmail);
  const isPublic = Number(preset?.isPublic ?? 1) === 1;

  if (!isPublic && !isOwner && !isAdmin) {
    return NextResponse.json({ error: "비공개 작품입니다." }, { status: 403 });
  }

  const chatId = randomUUID();
  const now = Date.now();

  const profile = db
    .prepare(`SELECT personaName, personaAge, personaGender, personaInfo FROM user_profile WHERE id=1`)
    .get() as any;

  // "새 대화 시작"은 기존을 전부 지우지 않고, 최신 3개까지 유지한다.
  // (생성 후 prune해서 새 채팅 + 직전 대화들을 이어하기에서 선택 가능하게 유지)

  db.prepare(`INSERT INTO chats (id, userEmail, presetId, title, createdAt) VALUES (?, ?, ?, ?, ?)`).run(
    chatId,
    u.email,
    presetId,
    null,
    now
  );
  // 작품 단위 누적 대화수는 채팅 삭제와 무관하게 증가만 유지한다.
  try {
    incrementPresetChatCount(String(presetId));
  } catch {
    // 집계 보정 실패로 채팅 생성 자체를 막지는 않는다.
  }

  // (요구사항)
  // 채팅을 시작할 때, 작업실에서 설정한 "첫 메시지"를 자동으로 출력(assistant 첫 메시지로 저장)한다.
  // - firstMessages는 JSON 배열 문자열이며, 첫 번째 항목을 사용한다.
  // - 저장 시에는 가능한 한 "상대 | \"...\"" 형태로 보정한다.
  try {
    const raw = String(preset?.firstMessages || "[]");
    let arr: any[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }

    // firstMessages는 작업실에서 JSON.stringify([{ text: "..." }]) 형태로 저장된다.
    // 과거/호환을 위해 string 배열(["..."])도 함께 지원한다.
    const firstEntry = arr?.[0];
    const first = (
      typeof firstEntry === "string"
        ? firstEntry
        : (firstEntry && typeof firstEntry === "object")
          ? String((firstEntry as any).text ?? (firstEntry as any).content ?? "")
          : ""
    ).trim();
    if (first) {
      // 선두 화자/작품명 접두(`강호말출 | "..."`)를 제거한다.
      // 스트리밍 응답(streamLoop의 resolveHeadPrefix)과 같은 규칙을 써서
      // 프롤로그와 이후 답변의 첫인상이 어긋나지 않게 한다.
      //
      // 이전 구현은 두 군데가 동시에 깨져 있어 접두가 한 번도 제거되지 않았다:
      //  (1) new RegExp(`^${npc}\s*\|`) — 템플릿 리터럴에서 \s -> "s", \| -> "|" 로
      //      백슬래시가 사라져 소스가 `^NPCs*|` 가 된다. 끝의 빈 대안(alternation)이
      //      모든 문자열에 매치되므로 hasPrefix는 항상 true였다.
      //  (2) 그 뒤 삼항이 뒤집혀 있어(hasPrefix ? first : contentOnly) 접두가 있을 때
      //      오히려 원문을 골랐고, contentOnly는 도달 불가능한 죽은 코드였다.
      //
      // 기존 방침(제작자 원문에 `NPC | "..."` wrapper를 덧씌우지 않는다)은 유지한다.
      // 여기서는 덧씌우지 않고 '있는 접두를 떼기만' 한다.
      const contentOnly = first.replace(/^[^|\n]{1,40}\|\s*/, "").trim();
      const finalText = convertTabTablesToHtml(contentOnly || first);

db.prepare(`INSERT INTO messages (id, chatId, role, content, createdAt, updatedAt, userEmail) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(),
        chatId,
        "assistant",
        encryptIfPossible(finalText),
        now,
        now,
        u.email
      );
    }
  } catch {
    // ignore
  }

  // 기본 설정 row 생성 (전역 페르소나 기본값을 복사)
  {
    const personaName = profile?.personaName ?? null;
    const personaAge = profile?.personaAge ?? null;
    const personaGender = profile?.personaGender ?? null;
    const personaInfo = profile?.personaInfo ?? null;

    // 모델/출력/추론 기본값 (chat_settings 스키마 컬럼명에 맞춤)
    const defaultModel = DEFAULT_CHAT_MODEL;
    const defaultMaxOutputTokens = 1200;
    const defaultMaxReasoningTokens = 384;

    // 장기기억(새 시스템) 기본값
    const defaultMemoryFrom = 7;
    const defaultSummaryEvery = 3;
    const defaultPerTurnChars = 80;
    const defaultNarrationColor = "#CCC7C7";

    db.prepare(
      `INSERT OR IGNORE INTO chat_settings (
        chatId,
        personaName, personaAge, personaGender, personaInfo,
        model, maxOutputTokens, maxReasoningTokens,
        memoryFrom, summaryEvery, summaryLength,
        narrationColor,
        updatedAt
      ) VALUES (
        ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?,
        ?
      )`
    ).run(
      chatId,
      personaName, personaAge, personaGender, personaInfo,
      defaultModel, defaultMaxOutputTokens, defaultMaxReasoningTokens,
      defaultMemoryFrom, defaultSummaryEvery, defaultPerTurnChars,
      defaultNarrationColor,
      now
    );
  }

  // 생성 직후 항상 상한(3개)을 유지한다.
  // => 이어하기가 3개를 넘으면 가장 오래된 대화부터 자동 정리됨
  prunePresetChats(String(u.email || ""), String(presetId || ""), MAX_CHATS_PER_PRESET_ON_NEW);

  return NextResponse.json({ chatId });
}
