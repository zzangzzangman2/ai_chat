import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { decryptIfPossible } from "@/lib/crypto";

export async function GET(req: Request) {
  const u = await getSessionUser();
  if (!u?.email) return NextResponse.json({ chats: [] });

  const { searchParams } = new URL(req.url);
  const presetId = String(searchParams.get("presetId") || "").trim();
  const limit = Math.min(Math.max(Number(searchParams.get("limit") || 10), 1), 50);

  if (!presetId) {
    return NextResponse.json({ error: "presetId가 필요합니다." }, { status: 400 });
  }

  const rows = db
    .prepare(
      `SELECT c.id, c.presetId, c.title, c.createdAt,
              (SELECT m.content FROM messages m WHERE m.chatId=c.id ORDER BY m.createdAt DESC LIMIT 1) AS lastMessage
       FROM chats c
       WHERE c.presetId=? AND c.userEmail=?
       ORDER BY c.createdAt DESC
       LIMIT ?`
    )
    .all(presetId, u.email, limit) as Array<{
      id: string;
      createdAt: number;
      title: string | null;
      lastMessage: string | null;
    }>;

  const chats = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    title: r.title || "",
    lastMessage: decryptIfPossible(String(r.lastMessage || "")).slice(0, 120),
  }));

  return NextResponse.json({ chats });
}
