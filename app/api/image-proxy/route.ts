import type { NextRequest } from "next/server";

// External image proxy
// - 목적: 브라우저가 외부 이미지 호스트의 핫링크/리퍼러 차단(403) 등에 걸릴 때
//         same-origin으로 이미지를 중계하여 표시 가능하게 한다.
// - 보안: SSRF 방지를 위해 기본은 allowlist(host) 기반.
//         필요 시 IMAGE_PROXY_ALLOW_HOSTS 환경변수로 허용 호스트를 추가한다.

export const runtime = "nodejs";

function parseAllowHosts(): string[] {
  const raw = String(process.env.IMAGE_PROXY_ALLOW_HOSTS || "bari.speedgabia.com,herks.org");
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isIpLiteral(host: string): boolean {
  // IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6
  if (host.includes(":")) return true;
  return false;
}

function isPrivateIpv4(host: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const parts = host.split(".").map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  return false;
}

export async function GET(req: NextRequest) {
  const urlParam = req.nextUrl.searchParams.get("url") || req.nextUrl.searchParams.get("u") || "";
  if (!urlParam) {
    return new Response("Missing url", { status: 400 });
  }

  let u: URL;
  try {
    u = new URL(urlParam);
  } catch {
    return new Response("Bad url", { status: 400 });
  }

  if (!(u.protocol === "https:" || u.protocol === "http:")) {
    return new Response("Unsupported protocol", { status: 400 });
  }

  const host = String(u.hostname || "").toLowerCase();
  if (!host) return new Response("Bad host", { status: 400 });
  if (host === "localhost" || host.endsWith(".local")) {
    return new Response("Host not allowed", { status: 403 });
  }
  if (isPrivateIpv4(host)) {
    return new Response("Private IP not allowed", { status: 403 });
  }
  // (보수적) IP 리터럴(특히 IPv6)은 차단한다. 필요하면 allowlist로만 열자.
  if (isIpLiteral(host) && !parseAllowHosts().includes(host)) {
    return new Response("IP host not allowed", { status: 403 });
  }

  const allow = parseAllowHosts();
  const allowAll = String(process.env.IMAGE_PROXY_ALLOW_ALL || "").trim() === "1";
  if (!allowAll) {
    if (!allow.includes(host)) {
      return new Response("Host not allowed", { status: 403 });
    }
  }

  // Hotlink 방지(Referer 체크) 우회 목적: referer를 원본 오리진으로 맞춘다.
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (compatible; ai-chat-image-proxy/1.0)",
    Referer: `${u.origin}/`,
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
  };

  let upstream: Response;
  try {
    upstream = await fetch(u.toString(), {
      redirect: "follow",
      headers,
      // nodejs runtime: signal/timeout은 환경에 따라 다르므로 단순 fetch
    });
  } catch (e: any) {
    return new Response(`Upstream fetch failed: ${String(e?.message || e)}`.slice(0, 300), { status: 502 });
  }

  if (!upstream.ok) {
    return new Response(`Upstream error: ${upstream.status}`, { status: upstream.status });
  }

  const ct = String(upstream.headers.get("content-type") || "");
  if (ct && !ct.toLowerCase().startsWith("image/")) {
    // 이미지가 아니라면 중계하지 않는다.
    return new Response("Upstream is not an image", { status: 415 });
  }

  // 캐싱: 동일 이미지 반복 로딩 비용 줄이기
  const cacheControl = "public, max-age=86400"; // 1 day
  const outHeaders = new Headers();
  if (ct) outHeaders.set("content-type", ct);
  outHeaders.set("cache-control", cacheControl);

  const etag = upstream.headers.get("etag");
  if (etag) outHeaders.set("etag", etag);

  return new Response(upstream.body, { status: 200, headers: outHeaders });
}
