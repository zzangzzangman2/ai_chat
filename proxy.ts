import { NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: ["/api/:path*"],
};

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // 기본은 **무로그**.
  // - 요청 메타(ua/referer/x-forwarded-for...)는 너무 시끄럽고 병목 분석에 도움이 적어서 제거.
  // - 필요하면 MW_LOG=1 로만 최소 라인을 활성화.
  const MW_LOG = process.env.MW_LOG === "1";
  if (MW_LOG && pathname.startsWith("/api/chat")) {
    const id = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    console.log(`[mw][${id}] ${req.method} ${pathname}${search}`);
  }

  return NextResponse.next();
}
