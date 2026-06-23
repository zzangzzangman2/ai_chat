import { NextResponse } from "next/server";
import { upsertUserByEmail } from "@/lib/db";
import {
  attachClearOauthCookies,
  attachClearSessionCookie,
  attachSessionCookie,
  exchangeGoogleCode,
  readOauthCookies,
  signSession,
  verifyGoogleIdToken,
} from "@/lib/auth";

export const runtime = "nodejs";

function getBaseUrl(req: Request) {
  const env = process.env.AUTH_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL;
  if (env) return env;

  // Best-effort: derive origin from forwarded headers (works behind CloudFront/ALB).
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  if (host) return `${proto}://${host}`;

  return "http://localhost:3000";
}
export async function GET(req: Request) {
  const base = getBaseUrl(req);
  const url = new URL(req.url);

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  // If Google returned an OAuth error, bounce back with a short signal.
  if (oauthError) {
    // clear temp oauth cookies
    // (set on response below)

    const redirect = new URL("/", base);
    redirect.searchParams.set("auth", "error");
    redirect.searchParams.set("reason", oauthError);
    const res = NextResponse.redirect(redirect);
    await attachClearSessionCookie(res);
    await attachClearOauthCookies(res);
    return res;
  }

  if (!code || !returnedState) {
    // clear temp oauth cookies
    // (set on response below)

    const redirect = new URL("/", base);
    redirect.searchParams.set("auth", "error");
    redirect.searchParams.set("reason", "missing_code_or_state");
    const res = NextResponse.redirect(redirect);
    await attachClearSessionCookie(res);
    await attachClearOauthCookies(res);
    return res;
  }

  const { state: storedState, codeVerifier } = await readOauthCookies();
  if (!storedState || !codeVerifier || storedState !== returnedState) {
    // clear temp oauth cookies
    // (set on response below)

    const redirect = new URL("/", base);
    redirect.searchParams.set("auth", "error");
    redirect.searchParams.set("reason", "state_mismatch");
    const res = NextResponse.redirect(redirect);
    await attachClearSessionCookie(res);
    await attachClearOauthCookies(res);
    return res;
  }

  try {
    // token exchange
    const tokens = await exchangeGoogleCode(code, codeVerifier);

    // verify id_token and build session user
    const user = await verifyGoogleIdToken(tokens.id_token);

    // sign session and set cookie
    const jwt = await signSession(user);


    // cleanup short-lived cookies
    // clear temp oauth cookies
    // (set on response below)


    const redirect = new URL("/", base);
    redirect.searchParams.set("auth", "ok");
    const res = NextResponse.redirect(redirect);
	  await attachSessionCookie(res, jwt);
    await attachClearOauthCookies(res);
    return res;
  } catch (err: any) {
    // clear temp oauth cookies
    // (set on response below)

    const redirect = new URL("/", base);
    redirect.searchParams.set("auth", "error");
    redirect.searchParams.set("reason", "callback_failed");
    // Avoid leaking full error; keep it short for logs.
    const res = NextResponse.redirect(redirect);
	  await attachClearSessionCookie(res);
    await attachClearOauthCookies(res);
    return res;
  }
}
