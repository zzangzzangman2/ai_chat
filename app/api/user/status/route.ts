import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("Pragma", "no-cache");
  res.headers.append("Vary", "Cookie");
  return res;
}

export async function GET(req: NextRequest) {
  void req;
  const session = await getSessionUser();
  if (!session?.email) {
    return noStore(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
  }

  const u = db.prepare(`SELECT role, is_banned, nickname, name FROM users WHERE email = ?`).get(session.email) as any;
  return noStore(
    NextResponse.json({
      ok: true,
      email: session.email,
      role: String(u?.role ?? "user"),
      isBanned: Number(u?.is_banned ?? 0) ? true : false,
      nickname: String(u?.nickname ?? u?.name ?? ""),
    })
  );
}
