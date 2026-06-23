import { NextResponse } from "next/server";
import { attachClearSessionCookie, getSessionUser } from "@/lib/auth";
import { markUserDeletedByEmail } from "@/lib/db";

export const runtime = "nodejs";

export async function POST() {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  markUserDeletedByEmail(session.email);

  const res = NextResponse.json({ ok: true });
  await attachClearSessionCookie(res);
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}
