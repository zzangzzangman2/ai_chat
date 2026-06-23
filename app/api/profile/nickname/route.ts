import { NextResponse } from "next/server";
import { getSessionUser, signSession, attachSessionCookie } from "@/lib/auth";
import { db, getUserByEmail, setUserNicknameByEmail, upsertUserByEmail } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const nickname = typeof body.nickname === "string" ? body.nickname.trim() : "";
  if (!nickname || nickname.length < 2 || nickname.length > 20) {
    return NextResponse.json({ ok: false, error: "invalid_nickname" }, { status: 400 });
  }

  // disallow duplicate nicknames across accounts
  const dup = db
    .prepare(`SELECT email FROM users WHERE lower(nickname)=lower(?) AND email<>? LIMIT 1`)
    .get(nickname, session.email) as any;
  if (dup?.email) {
    return NextResponse.json({ ok: false, error: "이미 사용 중인 닉네임입니다." }, { status: 409 });
  }

  // 1주일 1회 변경 제한 (최초 등록은 예외)
  const meRow = db
    .prepare(`SELECT nickname, nickname_changed_at, deleted_at, is_banned FROM users WHERE email = ?`)
    .get(session.email) as any;

  if (meRow && (Number(meRow.is_banned || 0) === 1 || meRow.deleted_at)) {
    return NextResponse.json({ ok: false, error: "account_disabled" }, { status: 403 });
  }

  const currentNick = typeof meRow?.nickname === "string" ? meRow.nickname.trim() : "";
  if (currentNick && currentNick !== nickname) {
    const last = Number(meRow?.nickname_changed_at || 0);
    if (last > 0) {
      const now = Date.now();
      const WEEK = 7 * 24 * 60 * 60 * 1000;
      const diff = now - last;
      if (diff < WEEK) {
        const remainMs = WEEK - diff;
        const remainHours = Math.ceil(remainMs / (60 * 60 * 1000));
        return NextResponse.json(
          { ok: false, error: `닉네임은 7일에 1번만 변경할 수 있어요. (${remainHours}시간 후 가능)` },
          { status: 429 }
        );
      }
    }
  }

  setUserNicknameByEmail(session.email, nickname);

  // 닉네임을 "첫 페르소나"로도 쓰고 싶다는 UX:
  // - 해당 계정에 persona_profiles가 0개면 1개를 자동 생성(작업실/채팅 기본값으로 자연스럽게 연결)
  try {
    const cnt = db
      .prepare(`SELECT COUNT(1) AS c FROM persona_profiles WHERE userEmail=?`)
      .get(session.email) as any;
    if (Number(cnt?.c || 0) === 0) {
      const now = Date.now();
      db.prepare(
        `INSERT INTO persona_profiles (id, userEmail, personaName, personaAge, personaGender, personaInfo, createdAt, updatedAt)
         VALUES (?, ?, ?, 0, '', '', ?, ?)`
      ).run(`p_${now}`, session.email, nickname, now, now);
    }
  } catch {
    // ignore
  }

  // refresh session cookie so client sees nickname without reload edge cases
  const dbUser = getUserByEmail(session.email);
  // DbUser 타입에 picture 필드가 없더라도(스키마/마이그레이션 차이),
  // 세션 토큰에 picture를 담는 기존 UX는 유지해야 한다.
  // 따라서 DB에서 picture 컬럼이 존재하는 경우만 안전하게 사용한다.
  // 스키마 차이: picture 또는 image
  const dbPicture = (dbUser as any)?.picture ?? (dbUser as any)?.image ?? null;
  const jwt = await signSession({
    email: session.email,
    name: dbUser?.name ?? session.name ?? null,
    picture: dbPicture ?? session.picture ?? null,
    nickname: nickname,
  });
  const res = NextResponse.json({ ok: true, nickname });
  await attachSessionCookie(res, jwt);
  return res;
}
