// 갤러리(Workspace) 이미지: {{img:REFKEY}} 토큰으로 채팅/소설 출력 중간에 삽입 가능
// preset.gallery는 JSON 문자열로 저장된다. (GalleryItem[] 포맷)

type GalleryItemForChat = { id?: string; dataUrl?: string; refKey?: string; desc?: string } | any;

export function parsePresetGallery(raw?: string | null): { refKey: string; dataUrl: string; desc: string }[] {
  if (!raw) return [];
  const txt = String(raw || "").trim();
  if (!txt) return [];
  try {
    const j = JSON.parse(txt) as GalleryItemForChat[] | any;
    if (!Array.isArray(j)) return [];
    const out: { refKey: string; dataUrl: string; desc: string }[] = [];
    for (const it of j) {
      if (it && typeof it === "object") {
        const refKey = String((it as any).refKey || "").trim();
        const dataUrl = String((it as any).dataUrl || "").trim();
        const desc = String((it as any).desc || "").trim();
        if (refKey && dataUrl) out.push({ refKey, dataUrl, desc });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function buildGalleryMap(raw?: string | null): Map<string, { src: string; desc: string }> {
  const map = new Map<string, { src: string; desc: string }>();
  const items = parsePresetGallery(raw);
  for (const it of items) map.set(it.refKey, { src: it.dataUrl, desc: it.desc });
  return map;
}
