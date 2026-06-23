import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { db, addPresetComment, listPresetComments } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const presetId = (searchParams.get("presetId") || "").trim();
  const limit = Math.max(1, Math.min(100, Number(searchParams.get("limit") || 50)));

  if (!presetId) return NextResponse.json({ ok: false, error: "presetId required" }, { status: 400 });

  const u = await getSessionUser();
  const comments = listPresetComments(presetId, u?.email || null, limit);

  // 댓글 작성자 정보(닉네임/프로필 이미지)까지 같이 내려준다
  const emails = Array.from(new Set(comments.map((c) => c.userEmail))).filter(Boolean);
  const usersMap = new Map<string, { nickname: string | null; image: string | null }>();
  if (emails.length > 0) {
    const placeholders = emails.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT email, nickname, image FROM users WHERE email IN (${placeholders})`)
      .all(...(emails as any[])) as any[];
    for (const r of rows) {
      usersMap.set(String(r.email), { nickname: r.nickname ?? null, image: r.image ?? null });
    }
  }

  const enriched = comments.map((c) => ({
    ...c,
    userNickname: usersMap.get(c.userEmail)?.nickname ?? null,
    userImage: usersMap.get(c.userEmail)?.image ?? null,
  }));

  const res = NextResponse.json({ ok: true, comments: enriched });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}

export async function POST(req: NextRequest) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const presetId = String(body?.presetId || "").trim();
    const content = String(body?.content || "");
    if (!presetId) return NextResponse.json({ ok: false, error: "presetId required" }, { status: 400 });

    const comment = addPresetComment(presetId, u.email, content);
    const meRow = db.prepare(`SELECT nickname, image FROM users WHERE email = ?`).get(u.email) as any;
    return NextResponse.json({
      ok: true,
      comment: {
        ...comment,
        userNickname: meRow?.nickname ?? null,
        userImage: meRow?.image ?? null,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 400 });
  }
}
