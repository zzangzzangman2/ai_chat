import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toggleCommentLike } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const commentId = String(body?.commentId || "").trim();
    if (!commentId) return NextResponse.json({ ok: false, error: "commentId required" }, { status: 400 });

    const { likeCount, likedByMe } = toggleCommentLike(commentId, u.email);
    return NextResponse.json({ ok: true, commentId, likeCount, likedByMe });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}
