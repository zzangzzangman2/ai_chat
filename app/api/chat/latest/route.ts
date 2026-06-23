import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export async function GET(req: Request) {
  const u = await getSessionUser();
  // 비로그인 상태에서도 동작해야 함: 공개 데이터는 userEmail=''로 저장/조회
  const userEmail = u?.email ?? "";

  const { searchParams } = new URL(req.url);
  const presetId = String(searchParams.get("presetId") || "").trim();
  if (!presetId) {
    return NextResponse.json({ error: "presetId가 필요합니다." }, { status: 400 });
  }

  const chat = db
    .prepare(
      `SELECT id, presetId, createdAt
       FROM chats
       WHERE presetId=? AND userEmail=?
       ORDER BY createdAt DESC
       LIMIT 1`
    )
    .get(presetId, userEmail) as any;

  return NextResponse.json({ chat: chat ? { id: chat.id, createdAt: chat.createdAt } : null });
}
