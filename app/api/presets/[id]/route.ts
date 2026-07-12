import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { db, deletePresetData } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  const { id } = await ctx.params;
  const row = db.prepare("SELECT * FROM presets WHERE id=?").get(id) as any;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 비공개 프리셋은 소유자/관리자만 조회 가능
  const isPublic = row?.isPublic === 0 ? 0 : 1;
  if (isPublic !== 1) {
    const u = await getSessionUser();
    const email = u?.email || "";
    const isAdmin = email ? isAdminEmail(email) : false;
    if (!email || (!isAdmin && String(row?.userEmail || "") !== email)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }
  return NextResponse.json(row);
}

export async function PUT(req: NextRequest, ctx: RouteCtx) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const { id } = await ctx.params;

  const row = db.prepare("SELECT * FROM presets WHERE id=?").get(id) as any;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isAdmin = isAdminEmail(u.email);
  if (!isAdmin && String(row?.userEmail || "") !== u.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const name = String(body.name ?? row.name).trim();
  const background = String(body.background ?? row.background);
  const character = String(body.character ?? row.character);
  const systemPrompt = String(body.systemPrompt ?? row.systemPrompt);

  db.prepare(
    `UPDATE presets SET name=?, background=?, character=?, systemPrompt=? WHERE id=?`
  ).run(name, background, character, systemPrompt, id);

  const updated = db.prepare("SELECT * FROM presets WHERE id=?").get(id);
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const row = db.prepare("SELECT * FROM presets WHERE id=?").get(id) as any;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isAdmin = isAdminEmail(u.email);
  if (!isAdmin && String(row?.userEmail || "") !== u.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  deletePresetData(id, isAdmin ? undefined : u.email);
  return NextResponse.json({ ok: true });
}
