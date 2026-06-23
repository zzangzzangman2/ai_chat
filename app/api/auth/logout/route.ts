import { NextResponse } from "next/server";
import { attachClearOauthCookies, attachClearSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Ensure all auth-related cookies are cleared on the response.
  await attachClearSessionCookie(res);
  await attachClearOauthCookies(res);
  return res;
}
