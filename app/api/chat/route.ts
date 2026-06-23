import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "Legacy chat endpoint is disabled. Use /api/chat/send.",
    },
    { status: 410 }
  );
}
