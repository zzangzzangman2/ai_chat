import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { NextResponse } from "next/server";

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function requireChatAccess(chatId: string) {
  const u = await getSessionUser();
  if (!u) return { ok: false as const, res: bad("unauthorized", 401) };
  if (!chatId) return { ok: false as const, res: bad("chatId가 필요합니다.") };

  const chat = db.prepare(`SELECT id FROM chats WHERE id=? AND userEmail=?`).get(chatId, u.email);
  if (!chat) return { ok: false as const, res: bad("채팅을 찾지 못했습니다.", 404) };
  return { ok: true as const, user: u };
}

export function decodeNameParam(raw: string): string {
  try {
    return decodeURIComponent(raw || "").trim();
  } catch {
    return String(raw || "").trim();
  }
}
