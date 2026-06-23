import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

function bad(msg: string) {
  return NextResponse.json({ error: msg }, { status: 400 });
}

// 페르소나 프로필 목록
export async function GET(req: any) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const rows = db
    .prepare(
      `SELECT id, personaName, personaAge, personaGender, personaInfo, createdAt, updatedAt
       FROM persona_profiles
       WHERE userEmail=?
       ORDER BY updatedAt DESC`
    )
    .all(u.email) as any[];

  const profiles = rows.map((r) => ({
    id: r.id,
    personaName: r.personaName,
    personaAge: Number(r.personaAge || 0),
    personaGender: r.personaGender,
    personaInfo: r.personaInfo,
    createdAt: Number(r.createdAt || 0),
    updatedAt: Number(r.updatedAt || 0),
  }));

  return NextResponse.json({ profiles });
}

// 생성/수정
export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json();

  const id = String(body.id || "").trim();
  const personaName = String(body.personaName || "").trim();
  const personaAge = Number(body.personaAge || 0);
  const personaGender = String(body.personaGender || "").trim();
  const personaInfo = String(body.personaInfo || "").trim();

  if (!personaName) return bad("캐릭터명을 적어주세요.");
  if (personaGender && personaGender !== "남" && personaGender !== "여") return bad("성별은 남/여 중에서 선택해주세요.");

  const now = Date.now();
  const pid = id || `p_${now}`;

  // upsert
  db.prepare(
    `INSERT INTO persona_profiles (id, userEmail, personaName, personaAge, personaGender, personaInfo, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       personaName=excluded.personaName,
       personaAge=excluded.personaAge,
       personaGender=excluded.personaGender,
       personaInfo=excluded.personaInfo,
       updatedAt=excluded.updatedAt`
  ).run(pid, u.email, personaName, personaAge, personaGender, personaInfo, now, now);

  return NextResponse.json({ ok: true, id: pid });
}

// 삭제: /api/profile?id=...
export async function DELETE(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const id = String(searchParams.get("id") || "").trim();
  if (!id) return bad("id가 필요합니다.");

  db.prepare(`DELETE FROM persona_profiles
       WHERE userEmail=? AND id=?`).run(u.email, id);
  return NextResponse.json({ ok: true });
}
