import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { togglePresetFollow } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const u = await getSessionUser();
  if (!u) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const presetId = String(body?.presetId || "").trim();
    if (!presetId) return NextResponse.json({ ok: false, error: "presetId required" }, { status: 400 });

    const { followCount, followedByMe } = togglePresetFollow(presetId, u.email);
    return NextResponse.json({ ok: true, followCount, followedByMe });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}
