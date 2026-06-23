"use client";

import React, { useMemo } from "react";

type Preset = {
  id: string;
  name: string;
  characterName?: string;
  character?: string;
  desc?: string;
  background?: string;
  image?: string;
  gallery?: string;
};

function displayTitle(preset: Preset) {
  return String(preset.characterName || preset.name || "(제목 없음)").trim();
}

function displayDesc(preset: Preset) {
  return String(preset.character || preset.desc || preset.background || "").trim();
}

function safeString(v: any) {
  return typeof v === "string" ? v : "";
}

function pickThumb(preset: Preset) {
  const img = safeString((preset as any).image).trim();
  if (img) return img;

  const rawGallery = safeString((preset as any).gallery).trim();
  if (rawGallery) {
    try {
      const parsed = JSON.parse(rawGallery);
      if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (typeof first === "string" && first.trim()) return first.trim();
        if (first && typeof first === "object") {
          const u = safeString((first as any).dataUrl || (first as any).url || (first as any).src || (first as any).image).trim();
          if (u) return u;
        }
      }
    } catch {
      // ignore
    }
  }

  return "";
}

export default function WorkSelectGrid(props: {
  presets: Preset[];
  selectedPresetId: string | null;
  onSelect: (presetId: string) => void;
}) {
  const items = useMemo(() => props.presets || [], [props.presets]);

  return (
    <section>
      <div style={{ fontWeight: 950, marginBottom: 14, fontSize: 18, color: "#e9eefc" }}>작품 선택</div>

      {items.length === 0 ? (
        <div
          style={{
            minHeight: 360,
            borderRadius: 18,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.04)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(233,238,252,0.72)",
            fontSize: 13,
          }}
        >
          프리셋이 없습니다.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: 14,
          }}
        >
          {items.map((preset) => {
            const active = props.selectedPresetId === preset.id;
            const title = displayTitle(preset);
            const desc = displayDesc(preset);
            const thumb = pickThumb(preset);

            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => props.onSelect(preset.id)}
                title={title}
                style={{
                  width: "100%",
                  display: "block",
                  textAlign: "left",
                  border: active ? "1px solid rgba(255,255,255,0.24)" : "1px solid rgba(255,255,255,0.10)",
                  background: active ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                  color: "#e9eefc",
                  borderRadius: 18,
                  cursor: "pointer",
                  padding: 12,
                  overflow: "hidden",
                  boxShadow: active ? "0 18px 38px rgba(0,0,0,0.34)" : "0 10px 26px rgba(0,0,0,0.20)",
                }}
              >
                <div
                  style={{
                    borderRadius: 14,
                    border: "1px solid rgba(255,255,255,0.10)",
                    background: "rgba(255,255,255,0.025)",
                    width: "100%",
                    aspectRatio: "3 / 4",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                  }}
                >
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt={title}
                      loading="lazy"
                      draggable={false}
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      onError={(e) => {
                        const img = e.currentTarget as HTMLImageElement;
                        if (img && img.src && !img.src.endsWith("/arca-headset.png")) img.src = "/arca-headset.png";
                      }}
                    />
                  ) : (
                    <div style={{ opacity: 0.62, fontSize: 12, fontWeight: 800 }}>No Image</div>
                  )}
                </div>

                <div
                  style={{
                    marginTop: 10,
                    fontSize: 16,
                    fontWeight: 950,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {title}
                </div>

                <div
                  style={{
                    marginTop: 6,
                    fontSize: 13,
                    opacity: 0.78,
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "normal",
                    lineHeight: 1.45,
                    height: 38,
                  }}
                  title={desc}
                >
                  {desc}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
