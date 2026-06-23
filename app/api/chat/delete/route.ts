import { NextResponse } from "next/server";
import { db, deleteChatData } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

function bad(msg: string, status: number = 400) {
  return NextResponse.json({ error: msg }, { status });
}

// 채팅을 즉시 삭제(히스토리/사용량/설정/요약 포함)
export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const body = await req.json();
    const chatId = String(body?.chatId || "").trim();
    if (!chatId) return bad("chatId가 필요합니다.");

    const chat = db.prepare(`SELECT id FROM chats WHERE id=? AND userEmail=?`).get(chatId, u.email) as any;
    if (!chat) return bad("채팅을 찾지 못했습니다.", 404);

    const tx = db.transaction(() => {
      deleteChatData(chatId);
      db.prepare(`DELETE FROM chats WHERE id=? AND userEmail=?`).run(chatId, u.email);
    });
    tx();

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return bad(e?.message || "삭제 중 오류가 발생했습니다.", 500);
  }
}
