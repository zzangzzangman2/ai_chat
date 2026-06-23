import { NextResponse } from "next/server";

/**
 * DEPRECATED / DISABLED
 *
 * This endpoint powered the old "장기기억(요약) 보기/편집" UI and could trigger
 * extra long-memory generation outside of /api/chat/send, causing token bloat.
 *
 * The app now uses:
 * - /api/chat/send (rolling summary + long-memory cache refresh on schedule)
 * - MemoryPanel UI (DB re-fetch only) via /api/chat/memory/summary
 *
 * Keeping this route as a hard-disabled stub prevents accidental calls.
 */
export const runtime = "nodejs";

function gone() {
  return NextResponse.json(
    {
      ok: false,
      error: "gone",
      message:
        "This endpoint has been removed. Use /api/chat/memory/refresh for summary generation and /api/chat/memory/summary for viewing.",
    },
    { status: 410 }
  );
}

export async function GET() {
  return gone();
}

export async function POST() {
  return gone();
}
