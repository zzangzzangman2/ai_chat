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

function ensureWallet(email: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO friendfee_wallet (userEmail, balance, updatedAt)
     VALUES (?, 0, ?)
     ON CONFLICT(userEmail) DO NOTHING`
  ).run(email, now);
}

function parseDayKey(k: string) {
  // YYYY-MM-DD (local date)
  const m = /^\d{4}-\d{2}-\d{2}$/.test(k) ? k : "";
  if (!m) return null;
  const [y, mo, d] = k.split("-").map((v) => parseInt(v, 10));
  const dt = new Date(y, (mo || 1) - 1, d || 1);
  if (Number.isNaN(dt.getTime())) return null;
  return { key: k, ms: dt.setHours(0, 0, 0, 0) };
}

function formatKeyFromMs(ms: number) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  const session = token ? await verifySession(token) : null;
  if (!session?.email) {
    return noStore(NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }));
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const dayKeyRaw = String(body?.dayKey || "");
  const parsed = parseDayKey(dayKeyRaw);
  if (!parsed) {
    return noStore(NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 }));
  }

  ensureWallet(session.email);

  const now = Date.now();

  // 하루 1회 고정 (idempotent)
  const existed = db
    .prepare(`SELECT 1 FROM friendfee_attendance WHERE userEmail = ? AND dayKey = ?`)
    .get(session.email, parsed.key);
  if (existed) {
    const w = db.prepare(`SELECT balance FROM friendfee_wallet WHERE userEmail = ?`).get(session.email) as any;
    const balance = Number(w?.balance ?? 0);
    return noStore(NextResponse.json({ ok: true, alreadyChecked: true, reward: 0, balance, balanceRounded: Math.round(balance) }));
  }

  // 연속 출석 계산
  const dayMs = 24 * 60 * 60 * 1000;
  const daysRows = db
    .prepare(`SELECT dayKey FROM friendfee_attendance WHERE userEmail = ? ORDER BY dayKey ASC`)
    .all(session.email) as any[];
  const set = new Set(daysRows.map((r) => String(r.dayKey)));
  // include today
  set.add(parsed.key);

  let streak = 1;
  let cursor = parsed.ms;
  while (true) {
    const prev = cursor - dayMs;
    const prevKey = formatKeyFromMs(prev);
    if (set.has(prevKey)) {
      streak += 1;
      cursor = prev;
      continue;
    }
    break;
  }
  const cycle = ((streak - 1) % 7) + 1;
  const reward = cycle === 7 ? 10000 : 5000;

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO friendfee_attendance (userEmail, dayKey, createdAt) VALUES (?, ?, ?)`)
      .run(session!.email, parsed.key, now);

    const w = db.prepare(`SELECT balance FROM friendfee_wallet WHERE userEmail = ?`).get(session!.email) as any;
    const bal = Number(w?.balance ?? 0);
    const next = bal + reward;
    db.prepare(`UPDATE friendfee_wallet SET balance = ?, updatedAt = ? WHERE userEmail = ?`).run(next, now, session!.email);
    db.prepare(
      `INSERT INTO friendfee_ledger (userEmail, kind, delta, balanceAfter, chatId, messageId, totalTokens, model, meta, createdAt)
       VALUES (?, 'checkin', ?, ?, NULL, ?, NULL, NULL, ?, ?)`
    ).run(session!.email, reward, next, parsed.key, JSON.stringify({ streak, cycle, reward }), now);
    return next;
  });

  try {
    const balance = tx();
    return noStore(
      NextResponse.json({ ok: true, alreadyChecked: false, reward, streak, cycleDay: cycle, balance, balanceRounded: Math.round(balance) })
    );
  } catch {
    return noStore(NextResponse.json({ ok: false, error: "server_error" }, { status: 500 }));
  }
}
