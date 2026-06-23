import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("Pragma", "no-cache");
  res.headers.append("Vary", "Cookie");
  return res;
}

// 1회성 마이그레이션: 기존(로컬스토리지) 잔액을 서버(DB)로 "초기 이관".
// - 서버 잔액이 0이고 ledger가 비어있을 때만 적용 (새 가입자/이미 서버에 값이 있는 경우엔 무시)
export async function POST(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookie) return noStore(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
  const session = await verifySession(cookie);
  if (!session?.email) return noStore(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));

  const body = await req.json().catch(() => null);
  const balance = Number(body?.balance);
  if (!Number.isFinite(balance) || balance <= 0) {
    return noStore(NextResponse.json({ ok: false, error: "invalid_balance" }, { status: 400 }));
  }

  const now = Date.now();
  const email = session.email;

  const tx = db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO friendfee_wallet(userEmail, balance, updatedAt) VALUES(?, 0, ?)`)
      .run(email, now);

    const ledCnt = db.prepare(`SELECT COUNT(1) AS c FROM friendfee_ledger WHERE userEmail = ?`).get(email) as any;
    const w = db.prepare(`SELECT balance FROM friendfee_wallet WHERE userEmail = ?`).get(email) as any;
    const cur = Number(w?.balance ?? 0) || 0;

    if ((Number(ledCnt?.c ?? 0) || 0) > 0) {
      return { applied: false, balance: cur };
    }
    if (cur > 0) {
      return { applied: false, balance: cur };
    }

    const next = Math.max(0, balance);
    db.prepare(`UPDATE friendfee_wallet SET balance = ?, updatedAt = ? WHERE userEmail = ?`).run(next, now, email);
    db.prepare(
      `INSERT INTO friendfee_ledger(userEmail, kind, delta, balanceAfter, createdAt) VALUES(?, 'import', ?, ?, ?)`
    ).run(email, next, next, now);
    return { applied: true, balance: next };
  });

  const r = tx();
  return noStore(NextResponse.json({ ok: true, applied: r.applied, balance: r.balance }));
}
