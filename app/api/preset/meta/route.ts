import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getPresetCreator, getPresetMeta, incrementPresetViews } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const presetId = (searchParams.get("presetId") || "").trim();
  if (!presetId) return NextResponse.json({ ok: false, error: "presetId required" }, { status: 400 });

  const u = await getSessionUser();
  const meta = getPresetMeta(presetId, u?.email || null);
  const creator = getPresetCreator(presetId);

  const res = NextResponse.json({ ok: true, meta, creator });
  res.headers.set("Cache-Control", "no-store, max-age=0");
  return res;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const presetId = String(body?.presetId || "").trim();
    const action = String(body?.action || "view");

    if (!presetId) return NextResponse.json({ ok: false, error: "presetId required" }, { status: 400 });

    if (action === "view") {
      // view increment does not require login (counts as anonymous view)
      incrementPresetViews(presetId);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: "unsupported action" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}
