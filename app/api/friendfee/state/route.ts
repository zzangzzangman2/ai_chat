import { NextResponse } from "next/server";

export const runtime = "nodejs";

function noStore(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store, max-age=0");
  res.headers.set("Pragma", "no-cache");
  return res;
}

export async function GET() {
  return noStore(
    NextResponse.json({
      ok: true,
      billingDisabled: true,
      balance: Number.MAX_SAFE_INTEGER,
      updatedAt: Date.now(),
      attendance: { days: [], lastCheck: null },
    })
  );
}
