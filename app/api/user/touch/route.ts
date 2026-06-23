import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { attachClearSessionCookie, SESSION_COOKIE, verifySession } from "@/lib/auth";

export const runtime = "nodejs";

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("Pragma", "no-cache");
  res.headers.append("Vary", "Cookie");
  return res;
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const session = token ? await verifySession(token) : null;
  if (!session?.email) {
    return noStore(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
  }

  // 탈퇴/정지 계정은 즉시 세션 해제
  const status = db.prepare(`SELECT is_banned, deleted_at FROM users WHERE email = ?`).get(session.email) as any;
  if (status && (Number(status.is_banned || 0) === 1 || status.deleted_at)) {
    const res = noStore(NextResponse.json({ ok: false, error: "account_disabled" }, { status: 403 }));
    await attachClearSessionCookie(res);
    return res;
  }

  const body = (await req.json().catch(() => null)) as any;
  const nickname = typeof body?.nickname === "string" ? body.nickname.slice(0, 80) : null;
  const name = typeof body?.name === "string" ? body.name.slice(0, 80) : null;
  const image = typeof body?.image === "string" ? body.image.slice(0, 500) : null;
  const action = typeof body?.action === "string" ? body.action : "seen"; // 'login'|'seen'

  const nowIso = new Date().toISOString();

  // upsert user row
  db.prepare(
    `INSERT INTO users (email, name, image, nickname, role, is_banned, created_at, updated_at, last_login_at, last_seen_at)
     VALUES (?, ?, ?, ?, COALESCE((SELECT role FROM users WHERE email = ?), 'user'), COALESCE((SELECT is_banned FROM users WHERE email = ?), 0), datetime('now'), datetime('now'), ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       name = COALESCE(excluded.name, users.name),
       image = COALESCE(excluded.image, users.image),
       nickname = COALESCE(excluded.nickname, users.nickname),
       updated_at = datetime('now'),
       last_seen_at = excluded.last_seen_at,
       last_login_at = CASE WHEN ? = 'login' THEN excluded.last_login_at ELSE users.last_login_at END`
  ).run(session.email, name, image, nickname, session.email, session.email, nowIso, nowIso, action);

  const u = db.prepare(`SELECT role, is_banned FROM users WHERE email = ?`).get(session.email) as any;

  return noStore(
    NextResponse.json({ ok: true, role: String(u?.role ?? 'user'), isBanned: Number(u?.is_banned ?? 0) ? true : false })
  );
}
