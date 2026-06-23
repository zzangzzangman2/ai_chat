import { NextResponse } from "next/server";
import { db, deletePresetData } from "@/lib/db";
import { getSessionUser, isAdminEmail } from "@/lib/auth";

function bad(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const isAdmin = isAdminEmail(u.email);
  try {
    const body = (await req.json()) as { id?: string };
    const id = String(body?.id || "").trim();
    if (!id) return bad("삭제할 프리셋 id가 필요합니다.");

    const preset = isAdmin
      ? (db.prepare(`SELECT id FROM presets WHERE id=?`).get(id) as any)
      : (db.prepare(`SELECT id FROM presets WHERE id=? AND userEmail=?`).get(id, u.email) as any);
    if (!preset) {
      return NextResponse.json({ error: "프리셋을 찾지 못했습니다." }, { status: 404 });
    }

    deletePresetData(id, isAdmin ? undefined : u.email);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "프리셋 삭제 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
