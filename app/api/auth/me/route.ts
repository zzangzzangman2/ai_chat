import { NextRequest, NextResponse } from "next/server";
import { attachClearSessionCookie, getSessionUser, isLocalAuthEnabled, SESSION_COOKIE, verifySession } from "@/lib/auth";
import { db, getUserByEmail, upsertUserByEmail } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const session = isLocalAuthEnabled() ? await getSessionUser() : token ? await verifySession(token) : null;

  let user: any = null;
  let shouldClear = false;
  if (session?.email) {
    if (isLocalAuthEnabled()) {
      upsertUserByEmail({
        email: session.email,
        name: session.name ?? undefined,
        image: session.picture ?? undefined,
      });
    }
    const row = db.prepare(`SELECT is_banned, deleted_at FROM users WHERE email = ?`).get(session.email) as any;
    if (!isLocalAuthEnabled() && row && (Number(row.is_banned || 0) === 1 || row.deleted_at)) {
      shouldClear = true;
      user = null;
    } else {
      const dbUser = getUserByEmail(session.email);
      user = {
        email: session.email,
        name: dbUser?.name ?? session.name ?? null,
        picture: (dbUser as any)?.image ?? (dbUser as any)?.picture ?? session.picture ?? null,
        nickname: dbUser?.nickname ?? session.nickname ?? session.name ?? null,
      };
    }
  }

  const res = NextResponse.json({ ok: true, user });
  if (shouldClear) {
    await attachClearSessionCookie(res);
  }

  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("Pragma", "no-cache");
  res.headers.append("Vary", "Cookie");
  return res;
}
