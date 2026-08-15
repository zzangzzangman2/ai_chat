import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import {
  DEFAULT_CHAT_MODEL,
  coerceChatModelId,
  defaultReasoningTokensForModel,
  isAllowedChatModel,
  isGemini3FlashModel,
  isGemini3ProModel,
  isReasoningPresetValue,
} from "@/lib/models";

// 장기기억(턴당 글자수) 기본값: 80
// (공백 포함) / 30~80(10단위)
const DEFAULT_SUMMARY_LENGTH = 80;
const DEFAULT_RENDER_MODE: "chat" | "novel" = "novel";
const DEFAULT_MODEL = DEFAULT_CHAT_MODEL;

function clampStepInt(n: any, def: number, min: number, max: number, step: number) {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  const i = Math.floor(v);
  const snapped = Math.round((i - min) / step) * step + min;
  return Math.min(max, Math.max(min, snapped));
}

function defaultReasoningTokens(model: string): number {
  return defaultReasoningTokensForModel(model);
}


function pickPublicSettings(row: any) {
  if (!row) return row;
  return {
    chatId: row.chatId,
    personaName: row.personaName,
    personaAge: row.personaAge,
    personaGender: row.personaGender,
    personaInfo: row.personaInfo,

    // 장기기억(새 규격)에서 실제로 쓰는 값만 노출
    memoryFrom: row.memoryFrom,
    summaryEvery: row.summaryEvery,
    summaryLength: row.summaryLength,

    userNote: row.userNote,
    model: row.model,
    maxOutputTokens: row.maxOutputTokens,
    maxReasoningTokens: row.maxReasoningTokens,
    narrationColor: row.narrationColor,
    renderMode: row.renderMode,
    updatedAt: row.updatedAt,
  };
}

function bad(msg: string, status: number = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chatId = (searchParams.get("chatId") || "").trim();
  if (!chatId) return bad("chatId가 필요합니다.");

  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const chat = db.prepare(`SELECT id FROM chats WHERE id=? AND userEmail=?`).get(chatId, u.email);
  if (!chat) return NextResponse.json({ error: "채팅을 찾지 못했습니다." }, { status: 404 });

  const row = db.prepare(`SELECT * FROM chat_settings WHERE chatId=?`).get(chatId) as any;

  // 설정이 아직 없으면(새 채팅/마이그레이션) 기본값(LOW)으로 내려준다.
  if (!row) {
    const model = DEFAULT_MODEL;
    const defaults = {
      chatId,
      personaName: "",
      personaAge: 0,
      personaGender: "",
      personaInfo: "",

      // 최근 원문(유저 입력) 고정 7턴
      memoryFrom: 7,

      // 장기기억(새 규격)
      summaryEvery: 3,
      summaryLength: DEFAULT_SUMMARY_LENGTH,

      userNote: "",
      model,

      // 출력/추론 기본값(LOW)
      maxOutputTokens: 1200,
      maxReasoningTokens: defaultReasoningTokens(model),

      // 기본 지문 색상 (RGB 204,199,199)
      narrationColor: "#CCC7C7",

      renderMode: DEFAULT_RENDER_MODE,
      updatedAt: Date.now(),
    };
    return NextResponse.json({ settings: pickPublicSettings(defaults) });
  }

  // 기존 DB 값이 예전 기본값이면 UX 기준(LOW)으로 자동 보정
  const patched: any = { ...row };
  let changed = false;

  // 모델 마이그레이션
  const normalizedPatchedModel = coerceChatModelId(String(patched.model || ""), DEFAULT_MODEL);
  if (patched.model !== normalizedPatchedModel) {
    patched.model = normalizedPatchedModel;
    changed = true;
  }
  if (!isAllowedChatModel(String(patched.model || ""))) {
    patched.model = DEFAULT_MODEL;
    changed = true;
  }

  // renderMode 보정 (소설 모드만 지원)
  if (patched.renderMode !== "novel") {
    patched.renderMode = "novel";
    changed = true;
  }
  // memoryFrom 고정 7턴
  if (Number(patched.memoryFrom ?? 0) !== 7) {
    patched.memoryFrom = 7;
    changed = true;
  }

  // 장기기억 고정 3턴 + (B 모드) 턴당 글자수 80 고정
  if (Number(patched.summaryEvery ?? 0) !== 3) {
    patched.summaryEvery = 3;
    changed = true;
  }
  if (Number(patched.summaryLength ?? 0) !== DEFAULT_SUMMARY_LENGTH) {
    patched.summaryLength = DEFAULT_SUMMARY_LENGTH;
    changed = true;
  }

  // 출력/추론 범위도 벗어나면 보정
  if (Number(patched.maxOutputTokens ?? 0) < 800) {
    patched.maxOutputTokens = 800;
    changed = true;
  }
  const patchedModel = String(patched.model || "");
  const minReasoning = isGemini3FlashModel(patchedModel) || isGemini3ProModel(patchedModel) ? 0 : 384;
  if (Number(patched.maxReasoningTokens ?? 0) < minReasoning) {
    patched.maxReasoningTokens = defaultReasoningTokens(String(patched.model || ""));
    changed = true;
  }

  // 예전 기본값 감지 → LOW로 downshift
  const mo = Number(patched.maxOutputTokens ?? 0);
  const mr = Number(patched.maxReasoningTokens ?? 0);
  const sl = Number(patched.summaryLength ?? 0);

  const looksLikeOldDefaults =
    (mo === 2000 && mr === 1024) ||
    (mo === 1300 && mr === 768 && sl === 120);

  if (looksLikeOldDefaults) {
    patched.maxOutputTokens = 1200;
    patched.maxReasoningTokens = defaultReasoningTokens(String(patched.model || ""));
    patched.summaryLength = DEFAULT_SUMMARY_LENGTH;
    changed = true;
  }

  if (changed) {
    db.prepare(
      `UPDATE chat_settings
       SET model=?, memoryFrom=?, summaryEvery=?, summaryLength=?, maxOutputTokens=?, maxReasoningTokens=?, renderMode=?, updatedAt=?
       WHERE chatId=?`
    ).run(
      patched.model,
      patched.memoryFrom,
      patched.summaryEvery,
      patched.summaryLength,
      patched.maxOutputTokens,
      patched.maxReasoningTokens,
      patched.renderMode,
      Date.now(),
      chatId
    );
  }

  return NextResponse.json({ settings: pickPublicSettings(patched) });
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const chatId = String(body.chatId || "").trim();
  if (!chatId) return bad("chatId가 필요합니다.");

  const chat = db.prepare(`SELECT id FROM chats WHERE id=? AND userEmail=?`).get(chatId, u.email);
  if (!chat) return NextResponse.json({ error: "채팅을 찾지 못했습니다." }, { status: 404 });

  const existingSettings = db
    .prepare(`SELECT model FROM chat_settings WHERE chatId=?`)
    .get(chatId) as { model?: string } | undefined;

  const personaName = String(body.personaName || "").trim();
  const personaAge = Number(body.personaAge || 0);
  const personaGender = String(body.personaGender || "").trim();
  const personaInfo = String(body.personaInfo || "").trim();

  // 고정 규칙
  const memoryFrom = 7;
  const summaryEvery = 3;
  // (B 모드) 턴당 글자수는 고정 80. 클라이언트 입력은 무시한다.
  const summaryLength = DEFAULT_SUMMARY_LENGTH;

  const narrationColor = String(body.narrationColor || "#CCC7C7");
  // 소설 모드만 지원 (클라이언트 입력값은 무시)
  const renderMode: "novel" = "novel";

  const userNote = String(body.userNote || "");

  let model = coerceChatModelId(String(body.model || DEFAULT_MODEL), DEFAULT_MODEL);

  const maxOutputTokens = Number(body.maxOutputTokens ?? 1200);
  let maxReasoningTokens = Number(body.maxReasoningTokens ?? defaultReasoningTokens(model));

  // --- Validation ---
  if (personaAge && (!Number.isFinite(personaAge) || personaAge < 0)) return bad("나이는 숫자로 적어주세요.");
  if (!isAllowedChatModel(model)) return bad("지원하지 않는 모델입니다.");
  if (!/^#[0-9a-fA-F]{6}$/.test(narrationColor)) return bad("지문 색상 값이 올바르지 않습니다.");

  // NOTE: UI에서는 "출력길이"를 글자수(자)로 노출한다.
  if (maxOutputTokens < 800 || maxOutputTokens > 5000) return bad("출력길이는 800~5000자 사이로 설정해 주세요.");
  const supportsZeroReasoning = isGemini3FlashModel(model) || isGemini3ProModel(model);
  const minReasoning = supportsZeroReasoning ? 0 : 384;
  const previousModel = existingSettings?.model
    ? coerceChatModelId(String(existingSettings.model), DEFAULT_MODEL)
    : "";
  const reasoningOutOfRange =
    !Number.isFinite(maxReasoningTokens) ||
    maxReasoningTokens < minReasoning ||
    maxReasoningTokens > 8192;

  // 모델만 바꿀 때 이전 모델의 합법적인 값(예: Gemini 3.x의 0)이 새 모델에서는
  // 불법일 수 있다. 사용자가 추론 설정까지 다시 고르게 하지 않고 새 모델의 LOW로 맞춘다.
  if (reasoningOutOfRange && previousModel && previousModel !== model) {
    maxReasoningTokens = defaultReasoningTokens(model);
  } else if (reasoningOutOfRange) {
    return bad(
      supportsZeroReasoning
        ? "추론길이는 0~8192 토큰 사이로 설정해 주세요."
        : "추론길이는 384~8192 토큰 사이로 설정해 주세요."
    );
  }

  // (2026-08-15) 범위 검사만으로는 부족하다.
  // 3.1 Pro의 LOW(384)는 3.7 Flash에서도 "범위 안"이라 위 분기를 그대로 통과하지만,
  // Flash 프리셋({0, 640, 1024}) 어디에도 없는 고아 값으로 남는다.
  // 그러면 UI는 가장 가까운 버튼을, 서버는 임계값 밴딩을 택해 서로 다른 단계를 쓴다.
  // (실측: 저장값 384 → 화면 MID / 실제 전송 low / reasoningTokens 0)
  // 모델이 바뀐 요청에 한해, 새 모델 버튼으로 만들 수 없는 값이면 새 모델 LOW로 스냅한다.
  if (
    previousModel &&
    previousModel !== model &&
    !isReasoningPresetValue(model, maxReasoningTokens)
  ) {
    maxReasoningTokens = defaultReasoningTokens(model);
  }

  const now = Date.now();

  db.prepare(
    `INSERT INTO chat_settings (
      chatId, personaName, personaAge, personaGender, personaInfo,
      memoryFrom, summaryEvery, summaryLength,
      userNote, model, maxOutputTokens, maxReasoningTokens, narrationColor, renderMode, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chatId) DO UPDATE SET
      personaName=excluded.personaName,
      personaAge=excluded.personaAge,
      personaGender=excluded.personaGender,
      personaInfo=excluded.personaInfo,
      memoryFrom=excluded.memoryFrom,
      summaryEvery=excluded.summaryEvery,
      summaryLength=excluded.summaryLength,
      narrationColor=excluded.narrationColor,
      renderMode=excluded.renderMode,
      userNote=excluded.userNote,
      model=excluded.model,
      maxOutputTokens=excluded.maxOutputTokens,
      maxReasoningTokens=excluded.maxReasoningTokens,
      updatedAt=excluded.updatedAt`
  ).run(
    chatId,
    personaName,
    personaAge || 0,
    personaGender,
    personaInfo,
    memoryFrom,
    summaryEvery,
    summaryLength,
    userNote,
    model,
    maxOutputTokens,
    maxReasoningTokens,
    narrationColor,
    renderMode,
    now
  );

  const row = db.prepare(`SELECT * FROM chat_settings WHERE chatId=?`).get(chatId);
  return NextResponse.json({ settings: pickPublicSettings(row) });
}
