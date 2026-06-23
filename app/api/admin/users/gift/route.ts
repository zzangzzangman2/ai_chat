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

function ensureWallet(email: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO friendfee_wallet (userEmail, balance, updatedAt)
     VALUES (?, 0, ?)
     ON CONFLICT(userEmail) DO NOTHING`
  ).run(email, now);
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin.ok) {
    return noStore(NextResponse.json({ ok: false, error: "forbidden" }, { status: admin.status }));
  }

  const body = (await req.json().catch(() => null)) as any;
  const email = String(body?.email ?? "").trim();
  const amount = Number(body?.amount ?? 0);
  const mode = String(body?.mode ?? "gift").toLowerCase(); // 'gift' | 'deduct'
  if (!email || !Number.isFinite(amount) || amount <= 0) {
    return noStore(NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 }));
  }

  // NOTE: admin은 무한 발행(잔액 차감 없음). 사용자 지갑만 조정.
  ensureWallet(email);

  const now = Date.now();
  const tx = db.transaction(() => {
    const w = db.prepare(`SELECT balance FROM friendfee_wallet WHERE userEmail = ?`).get(email) as any;
    const before = Number(w?.balance ?? 0);
    const isDeduct = mode === "deduct";
    const delta = isDeduct ? -amount : amount;
    if (isDeduct && before < amount) {
      // 차감은 잔액 이하만 허용 (0 미만 금지)
      throw Object.assign(new Error("insufficient"), { code: "INSUFFICIENT" });
    }
    const after = before + delta;
    db.prepare(`UPDATE friendfee_wallet SET balance = ?, updatedAt = ? WHERE userEmail = ?`).run(after, now, email);

    db.prepare(
      `INSERT INTO friendfee_ledger (userEmail, kind, delta, balanceAfter, chatId, messageId, totalTokens, model, meta, createdAt)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`
    ).run(
      email,
      isDeduct ? "admin_deduct" : "admin_gift",
      delta,
      after,
      `${isDeduct ? "deduct" : "gift"}:${now}:${Math.random().toString(16).slice(2)}`,
      JSON.stringify({ by: admin.session!.email }),
      now
    );

    db.prepare(`UPDATE users SET updated_at = datetime('now') WHERE email = ?`).run(email);
    return after;
  });

  try {
    const balance = tx();
    return noStore(NextResponse.json({ ok: true, balance }));
  } catch (e: any) {
    if (e?.code === "INSUFFICIENT" || String(e?.message || "") === "insufficient") {
      return noStore(NextResponse.json({ ok: false, error: "insufficient" }, { status: 402 }));
    }
    console.error("[admin.gift] failed", e);
    return noStore(NextResponse.json({ ok: false, error: "server_error" }, { status: 500 }));
  }
}
