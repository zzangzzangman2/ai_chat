import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

export const runtime = "nodejs";

const ADMIN_EMAILS = new Set(["godhotyes@gmail.com"]);

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("Pragma", "no-cache");
  res.headers.append("Vary", "Cookie");
  return res;
}

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const session = token ? await verifySession(token) : null;
  if (!session?.email) return { ok: false as const, status: 401, session: null };
  if (!ADMIN_EMAILS.has(session.email)) return { ok: false as const, status: 403, session };
  return { ok: true as const, status: 200, session };
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return noStore(NextResponse.json({ ok: false, error: "forbidden" }, { status: admin.status }));
  }

  const rows = db
    .prepare(
      `
      SELECT
        u.email,
        COALESCE(u.nickname, u.name, '') AS nickname,
        COALESCE(u.role, 'user') AS role,
        COALESCE(u.created_at, '') AS created_at,
        COALESCE(u.last_seen_at, u.last_login_at, u.updated_at, '') AS last_seen_at,
        COALESCE(u.is_banned, 0) AS is_banned,
        COALESCE(w.balance, 0) AS balance,
        COALESCE(SUM(CASE WHEN l.kind = 'spend' THEN -l.delta ELSE 0 END), 0) AS spent_total
      FROM users u
      LEFT JOIN friendfee_wallet w ON w.userEmail = u.email
      LEFT JOIN friendfee_ledger l ON l.userEmail = u.email
      WHERE COALESCE(u.is_banned, 0) = 0
      GROUP BY u.email
      ORDER BY last_seen_at DESC, created_at DESC
      `
    )
    .all() as any[];

  return noStore(
    NextResponse.json({
      ok: true,
      users: rows.map((r) => ({
        email: String(r.email),
        nickname: String(r.nickname ?? ""),
        role: String(r.role ?? "user"),
        createdAt: String(r.created_at ?? ""),
        lastSeenAt: String(r.last_seen_at ?? ""),
        isBanned: Number(r.is_banned ?? 0) ? true : false,
        balance: Number(r.balance ?? 0),
        spentTotal: Number(r.spent_total ?? 0),
      })),
    })
  );
}
