import { NextResponse } from "next/server";
import { buildGoogleAuthRedirect, attachOauthCookies, isLocalAuthEnabled } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (isLocalAuthEnabled()) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  const { url, state, codeVerifier } = await buildGoogleAuthRedirect();
  const res = NextResponse.redirect(url);
  await attachOauthCookies(res, state, codeVerifier);
  return res;
}
