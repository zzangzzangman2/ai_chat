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

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return noStore(NextResponse.json({ ok: false, error: "forbidden" }, { status: admin.status }));
  }

  const body = (await req.json().catch(() => null)) as any;
  const email = String(body?.email ?? "").trim();
  const role = String(body?.role ?? "user").trim();
  if (!email) return noStore(NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 }));
  if (!/^(user|admin)$/.test(role)) {
    return noStore(NextResponse.json({ ok: false, error: "invalid_role" }, { status: 400 }));
  }

  db.prepare(
    `UPDATE users SET role = ?, updated_at = datetime('now') WHERE email = ?`
  ).run(role, email);

  return noStore(NextResponse.json({ ok: true }));
}
