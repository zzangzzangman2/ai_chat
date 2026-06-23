import { NextResponse } from "next/server";

export const runtime = "nodejs";

function gone() {
  return NextResponse.json(
    { ok: false, error: "DEPRECATED: 캐릭터/씬 메모리 기능은 제거되었습니다." },
    { status: 410 }
  );
}

export const GET = gone;
export const POST = gone;
export const PUT = gone;
export const PATCH = gone;
export const DELETE = gone;
