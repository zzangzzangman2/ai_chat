import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export async function GET() {
  const u = await getSessionUser();
  if (!u?.email || !isAdminEmail(u.email)) return unauthorized();

  const rows = db
    .prepare(
      `SELECT id, imageUrl, linkUrl, isActive, sortOrder, createdAt
       FROM banners
       ORDER BY sortOrder ASC, createdAt DESC`
    )
    .all();

  return NextResponse.json(
    { ok: true, banners: rows },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u?.email || !isAdminEmail(u.email)) return unauthorized();

  const body = await req.json().catch(() => ({} as any));
  const imageUrl = String(body?.imageUrl || "").trim();
  const linkUrl = String(body?.linkUrl || "").trim();
  const isActive = body?.isActive === 0 || body?.isActive === false ? 0 : 1;
  const sortOrder = Number.isFinite(Number(body?.sortOrder)) ? Number(body?.sortOrder) : 0;

  if (!imageUrl) return NextResponse.json({ error: "imageUrl required" }, { status: 400 });

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO banners (imageUrl, linkUrl, isActive, sortOrder, createdAt)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(imageUrl, linkUrl, isActive, sortOrder, now);

  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}

export async function PUT(req: Request) {
  const u = await getSessionUser();
  if (!u?.email || !isAdminEmail(u.email)) return unauthorized();

  const body = await req.json().catch(() => ({} as any));
  const id = Number(body?.id || 0);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const patch: any = {};
  if (body?.imageUrl !== undefined) patch.imageUrl = String(body.imageUrl || "").trim();
  if (body?.linkUrl !== undefined) patch.linkUrl = String(body.linkUrl || "").trim();
  if (body?.isActive !== undefined) patch.isActive = body.isActive === 0 || body.isActive === false ? 0 : 1;
  if (body?.sortOrder !== undefined) patch.sortOrder = Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0;

  const sets: string[] = [];
  const args: any[] = [];
  for (const k of Object.keys(patch)) {
    sets.push(`${k}=?`);
    args.push(patch[k]);
  }
  if (!sets.length) return NextResponse.json({ ok: true });

  args.push(id);
  db.prepare(`UPDATE banners SET ${sets.join(", ")} WHERE id=?`).run(...args);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const u = await getSessionUser();
  if (!u?.email || !isAdminEmail(u.email)) return unauthorized();

  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id") || 0);
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  db.prepare(`DELETE FROM banners WHERE id=?`).run(id);
  return NextResponse.json({ ok: true });
}
