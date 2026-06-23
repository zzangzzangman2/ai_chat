import { cookies, headers } from "next/headers";
import type { NextResponse } from "next/server";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";

export type SessionUser = {
  email: string;
  name?: string | null;
  picture?: string | null;
  nickname?: string | null;
};

const LOCAL_AUTH_ENABLED = process.env.LOCAL_AUTH_DISABLED !== "1";
export const LOCAL_USER_EMAIL = (
  process.env.LOCAL_USER_EMAIL ||
  "godhotyes@gmail.com"
).trim().toLowerCase();
export const LOCAL_USER_NAME = process.env.LOCAL_USER_NAME || "Local User";
export const LOCAL_USER_NICKNAME = process.env.LOCAL_USER_NICKNAME || "로컬";

export function getLocalSessionUser(): SessionUser {
  return {
    email: LOCAL_USER_EMAIL || "local@arca.local",
    name: LOCAL_USER_NAME,
    picture: null,
    nickname: LOCAL_USER_NICKNAME,
  };
}

export function isLocalAuthEnabled() {
  return LOCAL_AUTH_ENABLED;
}

// --- Admin ---
// Admin is identified by email on the server side.
// Keep this minimal: do NOT expose admin flags to clients by default.
export const ADMIN_EMAILS = ["godhotyes@gmail.com"] as const;

export function isAdminEmail(email?: string | null) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return false;
  if ((ADMIN_EMAILS as readonly string[]).includes(e)) return true;
  return LOCAL_AUTH_ENABLED && e === (LOCAL_USER_EMAIL || "").toLowerCase();
}

export function isAdminUser(u?: SessionUser | null) {
  return isAdminEmail(u?.email);
}

export const SESSION_COOKIE = "sj_session";
export const STATE_COOKIE = "sj_oauth_state";
export const PKCE_COOKIE = "sj_oauth_pkce";

async function isSecure() {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  return proto === "https";
}

async function getOrigin() {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function base64url(input: Uint8Array) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function buildGoogleAuthUrl() {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const origin = await getOrigin();
  const redirectUri = `${origin}/api/auth/callback`;

  // CSRF state + PKCE
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = sha256Base64Url(codeVerifier);
// Node 20 doesn't support digestSync on subtle; compute with Node crypto fallback:
  // (This function runs on server, so Buffer/crypto is available)
  // We'll override if digestSync isn't available.
  return { clientId, origin, redirectUri, state, codeVerifier, codeChallenge: codeChallenge || "" };
}

function sha256Base64Url(str: string) {
  // Node crypto fallback
  const nodeCrypto = require("crypto") as typeof import("crypto");
  const hash = nodeCrypto.createHash("sha256").update(str).digest();
  return base64url(hash);
}

export async function setOauthCookies(state: string, codeVerifier: string) {
  const c = await cookies();
  const secure = await isSecure();
  c.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 10 * 60,
  });
  c.set(PKCE_COOKIE, codeVerifier, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 10 * 60,
  });
}

export async function readOauthCookies() {
  const c = await cookies();
  const state = c.get(STATE_COOKIE)?.value ?? null;
  const codeVerifier = c.get(PKCE_COOKIE)?.value ?? null;
  return { state, codeVerifier };
}

export async function clearOauthCookies() {
  const c = await cookies();
  const secure = await isSecure();
  c.set(STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
  c.set(PKCE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
}

export async function exchangeGoogleCode(code: string, codeVerifier: string) {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
  const origin = await getOrigin();
  const redirectUri = `${origin}/api/auth/callback`;

  const body = new URLSearchParams();
  body.set("code", code);
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("redirect_uri", redirectUri);
  body.set("grant_type", "authorization_code");
  body.set("code_verifier", codeVerifier);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${t}`);
  }
  return (await res.json()) as { id_token: string; access_token: string; expires_in: number; token_type: string; scope: string };
}

const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function verifyGoogleIdToken(idToken: string): Promise<SessionUser> {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    audience: clientId,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });

  const email = typeof payload.email === "string" ? payload.email : "";
  if (!email) throw new Error("No email in id_token");

  return {
    email,
    name: typeof payload.name === "string" ? payload.name : null,
    picture: typeof payload.picture === "string" ? payload.picture : null,
    nickname: null,
  };
}

function sessionKey() {
  const secret = mustEnv("AUTH_SESSION_SECRET");
  return new TextEncoder().encode(secret);
}

export async function signSession(user: SessionUser) {
  const now = Math.floor(Date.now() / 1000);
  // 30 days
  const exp = now + 30 * 24 * 60 * 60;

  return await new SignJWT({
    email: user.email,
    name: user.name ?? null,
    picture: user.picture ?? null,
    nickname: user.nickname ?? null,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(sessionKey());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  if (LOCAL_AUTH_ENABLED) return getLocalSessionUser();
  try {
    const { payload } = await jwtVerify(token, sessionKey(), { algorithms: ["HS256"] });
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!email) return null;
    return {
      email,
      name: typeof payload.name === "string" ? payload.name : null,
      picture: typeof payload.picture === "string" ? payload.picture : null,
      nickname: typeof payload.nickname === "string" ? payload.nickname : null,
    };
  } catch {
    return null;
  }
}

export async function getSessionUser(): Promise<SessionUser | null> {
  if (LOCAL_AUTH_ENABLED) return getLocalSessionUser();
  const c = await cookies();
  const token = c.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return await verifySession(token);
}


async function sessionCookieBaseOptions() {
  const secure = await isSecure();
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure,
    path: "/",
  };
}

export async function attachSessionCookie(res: NextResponse, jwt: string) {
  const base = await sessionCookieBaseOptions();
  res.cookies.set(SESSION_COOKIE, jwt, { ...base, maxAge: 30 * 24 * 60 * 60 });
}

export async function attachClearSessionCookie(res: NextResponse) {
  const base = await sessionCookieBaseOptions();
  res.cookies.set(SESSION_COOKIE, "", { ...base, maxAge: 0 });
}

export async function attachOauthCookies(res: NextResponse, state: string, codeVerifier: string) {
  const base = await sessionCookieBaseOptions();
  // Short-lived: 10 minutes
  res.cookies.set(STATE_COOKIE, state, { ...base, maxAge: 10 * 60 });
  res.cookies.set(PKCE_COOKIE, codeVerifier, { ...base, maxAge: 10 * 60 });
}

export async function attachClearOauthCookies(res: NextResponse) {
  const base = await sessionCookieBaseOptions();
  res.cookies.set(STATE_COOKIE, "", { ...base, maxAge: 0 });
  res.cookies.set(PKCE_COOKIE, "", { ...base, maxAge: 0 });
}

export async function setSessionCookie(jwt: string) {
  const c = await cookies();
  const secure = await isSecure();
  c.set(SESSION_COOKIE, jwt, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const c = await cookies();
  const secure = await isSecure();
  c.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
}

export async function buildGoogleAuthRedirect() {
  const clientId = mustEnv("GOOGLE_CLIENT_ID");
  const origin = await getOrigin();
  const redirectUri = `${origin}/api/auth/callback`;

  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = sha256Base64Url(codeVerifier);

  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("redirect_uri", redirectUri);
  params.set("response_type", "code");
  params.set("scope", "openid email profile");
  params.set("state", state);
  params.set("code_challenge", codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("access_type", "offline");
  params.set("prompt", "select_account");

  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state, codeVerifier };
}


export async function requireSessionUser() {
  const u = await getSessionUser();
  if (!u) {
    return null;
  }
  return u;
}
