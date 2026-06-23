import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// 1차: 작품(프리셋) 상세 모달에서 "채팅수" 표시용
// - 인증/권한은 기존 /api/chat/list 와 동일하게 두지 않음(로컬 단일 사용자 전제)
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const presetId = String(searchParams.get("presetId") || "").trim();

  if (!presetId) {
    return NextResponse.json({ error: "presetId가 필요합니다." }, { status: 400 });
  }

  type CountRow = { cnt?: number | null };
  const row = db.prepare(`SELECT chatCountTotal AS cnt FROM preset_stats WHERE presetId = ?`).get(presetId) as CountRow | undefined;
  const fallback = row
    ? null
    : (db.prepare(`SELECT COUNT(1) AS cnt FROM chats WHERE presetId = ?`).get(presetId) as CountRow | undefined);
  const count = Number(row?.cnt ?? fallback?.cnt ?? 0);
  return NextResponse.json({ count: Number.isFinite(count) ? count : 0 });
}
