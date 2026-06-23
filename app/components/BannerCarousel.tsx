"use client";

import { useEffect, useMemo, useState } from "react";

type Banner = {
  id: number;
  imageUrl: string;
  linkUrl?: string;
};

function withCacheBuster(url: string, v: string | number): string {
  const u = String(url || "");
  if (!u) return u;
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}v=${encodeURIComponent(String(v))}`;
}

export default function BannerCarousel({ height = 220 }: { height?: number }) {
  const [items, setItems] = useState<Banner[]>([]);
  const [idx, setIdx] = useState(0);

  const load = async () => {
    try {
      const res = await fetch("/api/banners");
      const json = await res.json();
      const list = Array.isArray(json?.banners) ? json.banners : [];
      setItems(list);
      setIdx(0);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const kickoff = window.setTimeout(() => {
      void load();
    }, 0);

    // Poll the live list. Draft edits won't affect the homepage until admin clicks "적용",
    // so polling won't show intermediate changes.
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load();
    }, 30000);

    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!items.length) return;
    const t = window.setInterval(() => {
      setIdx((v) => (v + 1) % items.length);
    }, 3000);
    return () => window.clearInterval(t);
  }, [items]);

  const current = useMemo(() => (items.length ? items[idx % items.length] : null), [items, idx]);
  const src = current ? withCacheBuster(current.imageUrl, current.id) : "";

  if (!current) return null;

  return (
    <div
      style={{
        width: "100%",
        height,
        borderRadius: 18,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(255,255,255,0.03)",
        position: "relative",
        marginBottom: 16,
      }}
    >
      {current.linkUrl ? (
        <a
          href={current.linkUrl}
          target="_blank"
          rel="noreferrer"
          style={{ display: "block", width: "100%", height: "100%" }}
        >
          <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        </a>
      ) : (
        <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      )}

      {/* dots */}
      {items.length > 1 && (
        <div style={{ position: "absolute", right: 14, bottom: 12, display: "flex", gap: 6 }}>
          {items.map((b, i) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setIdx(i)}
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                background: i === idx ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.35)",
              }}
              aria-label={`banner-${i}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
