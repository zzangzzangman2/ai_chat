"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Preset } from "@/app/page";

type Theme = {
  bg: string;
  panel: string;
  panel2: string;
  border: string;
  borderSoft: string;
  text: string;
  muted: string;
};

type Props = {
  theme: Theme;
  presets: Preset[];
  selectedPresetId: string | null;
  onSelectPreset: (id: string | null) => void;
  onUpdatePreset: (p: Preset) => void;
  onDeletePreset: (id: string) => void;
};

type WorkspaceTab = "basic" | "gallery" | "detail" | "lorebook";
type TargetAudience = "all" | "male" | "female";

type GalleryItem = {
  id: string;
  dataUrl: string; // base64 data url
  refKey: string;
  desc: string;
};

type LoreItem = {
  id: string;
  name: string;
  content: string;
  activationKeys: string[];
  alwaysOn?: boolean;
  isOpen?: boolean;
};


function stripExtension(filename: string) {
  // "a.b.c.png" -> "a.b.c"
  return filename.replace(/\.[^/.]+$/, "");
}

function randomRefKey(existing: Set<string>) {
  // 6 chars, mixed-case + digits (avoid confusing chars like 0/O, 1/I/l)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

  const pick = () => {
    let out = "";
    // use crypto if available
    if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      for (let i = 0; i < 6; i++) out += chars[bytes[i] % chars.length];
      return out;
    }
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  };

  // try a few times, then fall back to time-based suffix
  for (let i = 0; i < 50; i++) {
    const k = pick();
    if (!existing.has(k)) return k;
  }
  const fallback = (Date.now().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/gi, "").slice(0, 6);
  return existing.has(fallback) ? pick() : fallback;
}

function utf8Bytes(s: string) {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    // very old browsers only
    return s.length;
  }
}

function isNearBottom(el: HTMLElement, thresholdPx = 120) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
}


function LoreKeyEditor({
  theme: THEME,
  keys,
  onAdd,
  onRemove,
}: {
  theme: Theme;
  keys: string[];
  onAdd: (k: string) => void;
  onRemove: (k: string) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="활성화 키를 작성해 주세요."
          style={{
            flex: 1,
            padding: "12px 12px",
            borderRadius: 12,
            border: `1px solid ${THEME.borderSoft}`,
            background: THEME.panel2,
            color: THEME.text,
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const v = draft.trim();
              if (!v) return;
              onAdd(v);
              setDraft("");
            }
          }}
        />
        <button
          type="button"
          onClick={() => {
            const v = draft.trim();
            if (!v) return;
            onAdd(v);
            setDraft("");
          }}
          style={{
            width: 70,
            height: 42,
            borderRadius: 12,
            border: `1px solid ${THEME.borderSoft}`,
            background: THEME.panel,
            color: THEME.text,
            fontWeight: 800,
          }}
        >
          추가
        </button>
      </div>

      {keys.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {keys.map((k) => (
            <div
              key={k}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 10px",
                borderRadius: 999,
                border: `1px solid ${THEME.borderSoft}`,
                background: THEME.panel,
                fontSize: 12,
              }}
            >
              <span>{k}</span>
              <button
                type="button"
                onClick={() => onRemove(k)}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  border: `1px solid ${THEME.borderSoft}`,
                  background: "transparent",
                  color: "#ef4444",
                  lineHeight: "16px",
                }}
                title="삭제"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function Workspace({ theme: THEME, presets, selectedPresetId, onSelectPreset, onUpdatePreset, onDeletePreset }: Props) {
  const [tab, setTab] = useState<WorkspaceTab>("basic");
  const [view, setView] = useState<"list" | "edit">("list");

  // 작업실 카드에서 바로 채팅 시작하기
  const openChatForPreset = useCallback((presetId: string) => {
    try {
      const fn = (window as any).__mate_open_work_modal;
      if (typeof fn === "function") {
        fn(presetId);
        return;
      }

      window.dispatchEvent(new CustomEvent("mate:openChatForPreset", { detail: { presetId } }));
    } catch {
      // ignore
    }
  }, []);

  const selectedPreset = useMemo(() => {
    if (!selectedPresetId) return null;
    return presets.find((p) => p.id === selectedPresetId) || null;
  }, [presets, selectedPresetId]);


  const didClearSelectionOnEnter = useRef(false);
  useEffect(() => {
    // 작업실 진입 시에만(최초 1회) 기존 선택을 해제합니다.
    // 리스트에서 "수정"을 눌러 선택하는 동작까지 지우면 편집이 불가능해지므로,
    // 최초 1회만 동작하도록 가드합니다.
    if (didClearSelectionOnEnter.current) return;
    didClearSelectionOnEnter.current = true;
    if (selectedPresetId) onSelectPreset(null);
  }, [selectedPresetId, onSelectPreset]);


  // ✅ 작업실은 기본적으로 "새로 만들기" 모드. (선택된 작품이 없으면 로컬 드래프트를 사용)
  const DRAFT_ID = "__draft__";
  const [draftPreset, setDraftPreset] = useState<Preset>(() => ({
    id: DRAFT_ID,
    name: "새 작품",
    background: "",
    characterName: "",
    characterAge: 0,
    character: "",
    systemPrompt: "",
    image: "",
    tags: "",
    target: "all",
    gallery: "[]",
    firstMessages: "[]",
    lorebooks: "[]",
    isPublic: 1,
    isNsfw: 0,
    createdAt: Date.now(),
  }));
  const storageKeys = useMemo(() => {
    const id = selectedPresetId || DRAFT_ID;
    return {
      image: `workspace.mainImage.${id}`,
      tags: `workspace.tags.${id}`,
      target: `workspace.target.${id}`,
      gallery: `workspace.gallery.${id}`,
      firstMessage: `workspace.firstMessage.${id}`,
      lorebook: `workspace.lorebook.${id}`,
      lorebookDirty: `workspace.lorebookDirty.${id}` as const,
      isPublic: `workspace.isPublic.${id}`,
      isNsfw: `workspace.isNsfw.${id}`,
    };
  }, [selectedPresetId]);

  // 공개/비공개(리스트 노출)
  // - 기본값: 공개(true)
  // - 편집 시: 로컬 초안(workspace.isPublic.<presetId>)이 있으면 그 값을 우선
  // - 그 외: 서버에 저장된 preset.isPublic 값 사용
  const [isPublicLocal, setIsPublicLocal] = useState<boolean>(true);

  // 성인 콘텐츠(NSFW)
  // - 기본값: OFF(false)
  // - 편집 시: 로컬 초안(workspace.isNsfw.<presetId>)이 있으면 그 값을 우선
  // - 그 외: 서버에 저장된 preset.isNsfw 값 사용
  const [isNsfwLocal, setIsNsfwLocal] = useState<boolean>(false);

  // 드래프트 모드에서 draftPreset(로컬 복구)로 isPublic이 갱신될 수 있으므로 동기화
  // - workspace.isPublic.__draft__가 있으면 그 값을 우선
  // - 없으면 draftPreset.isPublic로 반영
  useEffect(() => {
    if (selectedPresetId) return;
    try {
      const stored = localStorage.getItem(storageKeys.isPublic);
      if (stored === "0" || stored === "1") return;
    } catch {
      // ignore
    }
    setIsPublicLocal(Boolean(((draftPreset as any).isPublic ?? 1)));
  }, [selectedPresetId, storageKeys.isPublic, (draftPreset as any).isPublic]);

  // 드래프트 모드에서 draftPreset(로컬 복구)로 isNsfw가 갱신될 수 있으므로 동기화
  // - workspace.isNsfw.__draft__가 있으면 그 값을 우선
  // - 없으면 draftPreset.isNsfw로 반영
  useEffect(() => {
    if (selectedPresetId) return;
    try {
      const stored = localStorage.getItem(storageKeys.isNsfw);
      if (stored === "0" || stored === "1") return;
    } catch {
      // ignore
    }
    setIsNsfwLocal(Boolean(((draftPreset as any).isNsfw ?? 0)));
  }, [selectedPresetId, storageKeys.isNsfw, (draftPreset as any).isNsfw]);


  // 드래프트 로드/저장 (새로고침 대비)
  useEffect(() => {
    try {
      const raw = localStorage.getItem("workspace.draftPreset.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        setDraftPreset((prev) => ({ ...prev, ...parsed, id: DRAFT_ID }));
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("workspace.draftPreset.v1", JSON.stringify({
        name: draftPreset.name,
        background: draftPreset.background,
        characterName: draftPreset.characterName,
        characterAge: draftPreset.characterAge,
        character: draftPreset.character,
        systemPrompt: draftPreset.systemPrompt,
        image: draftPreset.image,
        tags: draftPreset.tags,
        target: draftPreset.target,
        gallery: draftPreset.gallery,
        firstMessages: draftPreset.firstMessages,
        lorebooks: draftPreset.lorebooks,
        isPublic: (draftPreset as any).isPublic,
        isNsfw: (draftPreset as any).isNsfw,
      }));
    } catch {
      // ignore
    }
  }, [draftPreset]);

  // local-only meta (이미지/태그/타겟유저층)
  const [imageDataUrl, setImageDataUrl] = useState<string>("");
  const [tagsText, setTagsText] = useState<string>("");
  const [tagDraft, setTagDraft] = useState<string>("");

  // 태그는 내부적으로 배열로 다루되, 저장 포맷은 기존과 호환되게 comma-separated 문자열을 유지합니다.
  const tags = useMemo(() => {
    return (tagsText || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }, [tagsText]);

  function setTagsList(next: string[]) {
    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const raw of next) {
      const v = (raw || "").trim();
      if (!v) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      uniq.push(v);
    }
    const text = uniq.join(",");
    setTagsText(text);
    persistLocal({ tags: text });
  }

  function addTagsFromInput(raw: string) {
    const v = (raw || "").trim();
    if (!v) return;
    // "A, B, C" 붙여넣기 대응
    const parts = v
      .split(/[\n\r\t,]+/g)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!parts.length) return;
    setTagsList([...tags, ...parts]);
    setTagDraft("");
  }

  function removeTag(name: string) {
    setTagsList(tags.filter((t) => t !== name));
  }

  const [target, setTarget] = useState<TargetAudience>("all");
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [firstMessage, setFirstMessage] = useState<string>("");
  const [loreItems, setLoreItems] = useState<LoreItem[]>([]);
  const lorebooksTouchedRef = useRef(false);
  const loreDragIndexRef = useRef<number | null>(null);
  const galleryFileRef = useRef<HTMLInputElement | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const setIsPublic = useCallback(
    (v: boolean) => {
      setIsPublicLocal(v);
      // 새로 만들기(드래프트)일 때는 드래프트에도 반영해서 새로고침 복구가 되게 한다.
      if (!selectedPresetId) {
        setDraftPreset((prev) => ({ ...prev, isPublic: v ? 1 : 0 } as any));
      }
      try {
        localStorage.setItem(storageKeys.isPublic, v ? "1" : "0");
      } catch {
        // ignore
      }
    },
    [selectedPresetId, storageKeys.isPublic]
  );

  const setIsNsfw = useCallback(
    (v: boolean) => {
      setIsNsfwLocal(v);
      // 드래프트에도 반영(새로고침 복구)
      if (!selectedPresetId) {
        setDraftPreset((prev) => ({ ...prev, isNsfw: v ? 1 : 0 } as any));
      }
      try {
        localStorage.setItem(storageKeys.isNsfw, v ? "1" : "0");
      } catch {
        // ignore
      }
    },
    [selectedPresetId, storageKeys.isNsfw]
  );

  const isDraft = !selectedPresetId;
  const currentPreset = selectedPreset ?? draftPreset;

  useEffect(() => {
    // ⚠️ 중요: 드래프트 모드(selectedPresetId가 null)에서 draftPreset이 바뀔 때마다
    // 아래 초기화 로직이 다시 실행되면(의존성에 draftPreset이 들어가면)
    // 이미지/태그/갤러리/로어북 등이 "입력하다가 갑자기 사라지는" 현상이 발생합니다.
    // 따라서 이 effect는 "선택된 프리셋이 바뀔 때"만 동작해야 합니다.

    if (!selectedPresetId) {
      // 드래프트: 로컬스토리지(__draft__)에 저장된 값이 있으면 우선 복구
      try {
        const storedImage = localStorage.getItem(storageKeys.image) || "";
        setImageDataUrl(storedImage || "");

        const storedTags = localStorage.getItem(storageKeys.tags) || "";
        setTagsText(storedTags || "");

        const t = (localStorage.getItem(storageKeys.target) || "all") as TargetAudience;
        setTarget(t === "male" || t === "female" || t === "all" ? t : "all");

        const rawGallery = localStorage.getItem(storageKeys.gallery) || "";
        if (rawGallery) {
          try {
            const parsed = JSON.parse(rawGallery);
            setGalleryItems(Array.isArray(parsed) ? parsed : []);
          } catch {
            setGalleryItems([]);
          }
        } else {
          setGalleryItems([]);
        }

        const storedFirst = localStorage.getItem(storageKeys.firstMessage) || "";
        setFirstMessage(storedFirst || "");

        const loreStorageKey = (storageKeys as any).lorebook as string;
        const rawLore = localStorage.getItem(loreStorageKey) || "";
        if (rawLore) {
          try {
            const parsed = JSON.parse(rawLore);
            setLoreItems(Array.isArray(parsed) ? parsed : []);
          } catch {
            // 로컬 초안이 깨져있으면 삭제하고 빈 값으로 초기화
            try { localStorage.removeItem(loreStorageKey); } catch {}
            setLoreItems([]);
          }
        } else {
          setLoreItems([]);
        }
        lorebooksTouchedRef.current = false;


// 드래프트 공개 설정: 로컬스토리지(workspace.isPublic.__draft__) → draftPreset 값 → 기본(공개)
        const storedPublic = localStorage.getItem(storageKeys.isPublic);
        if (storedPublic === "0" || storedPublic === "1") {
          setIsPublicLocal(storedPublic === "1");
        } else {
          setIsPublicLocal(Boolean(((draftPreset as any).isPublic ?? 1)));
        }

        // 드래프트 NSFW: 로컬스토리지(workspace.isNsfw.__draft__) → draftPreset 값 → 기본(OFF)
        const storedNsfw = localStorage.getItem(storageKeys.isNsfw);
        if (storedNsfw === "0" || storedNsfw === "1") {
          setIsNsfwLocal(storedNsfw === "1");
        } else {
          setIsNsfwLocal(Boolean(((draftPreset as any).isNsfw ?? 0)));
        }
      } catch {
        // fallback
        setImageDataUrl("");
        setTagsText("");
        setTarget("all");
        setGalleryItems([]);
        setFirstMessage("");
        setLoreItems([]);
        setIsPublicLocal(Boolean(((draftPreset as any).isPublic ?? 1)));
        setIsNsfwLocal(Boolean(((draftPreset as any).isNsfw ?? 0)));
      }
      return;
    }
    try {
      // 수정 화면 진입 시: 로컬 초안이 있으면 우선 사용, 없으면 서버에 저장된 프리셋 값을 그대로 보여준다.
      // (로컬이 비어있으면 imageDataUrl/galleryItems가 빈 값으로 남아 저장 시 기존 이미지가 날아가는 문제가 있었음)
      const storedImage = localStorage.getItem(storageKeys.image) || "";
      const presetImage = typeof (selectedPreset as any)?.image === "string" ? String((selectedPreset as any).image) : "";
      setImageDataUrl(storedImage || presetImage || "");

      const storedTags = localStorage.getItem(storageKeys.tags) || "";
      const presetTags = typeof (selectedPreset as any)?.tags === "string" ? String((selectedPreset as any).tags) : "";
      setTagsText(storedTags || presetTags || "");
      const t = (localStorage.getItem(storageKeys.target) || "all") as TargetAudience;
      setTarget(t === "male" || t === "female" || t === "all" ? t : "all");

      const storedFirst = localStorage.getItem(storageKeys.firstMessage) || "";
      const presetFirstMessages =
        (typeof (selectedPreset as any)?.firstMessages === "string" ? String((selectedPreset as any).firstMessages) : "") ||
        (typeof (selectedPreset as any)?.firstMessage === "string" ? String((selectedPreset as any).firstMessage) : "");

      const parseFirstMessage = (raw: string): string => {
        if (!raw) return "";
        const trimmed = String(raw).trim();
        // 레거시: 단일 문자열로 저장된 경우(JSON이 아님)
        if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return trimmed;
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const first = parsed[0] as any;
            if (typeof first === "string") return first;
            if (first && typeof first === "object" && typeof first.text === "string") return String(first.text);
          }
        } catch {
          // ignore
        }
        return "";
      };

      setFirstMessage(storedFirst || parseFirstMessage(presetFirstMessages) || "");
      const rawGallery = localStorage.getItem(storageKeys.gallery) || "";
      const presetGallery = typeof (selectedPreset as any)?.gallery === "string" ? String((selectedPreset as any).gallery) : "";

      const parseGallery = (raw: string): GalleryItem[] => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          // legacy/다른 포맷 대응: string[] 형태도 허용
          return parsed
            .map((it: any): GalleryItem | null => {
              if (typeof it === "string" && it.trim()) {
                return { id: genId(), dataUrl: it.trim(), refKey: "", desc: "" };
              }
              if (it && typeof it === "object") {
                const dataUrl = typeof it.dataUrl === "string" ? it.dataUrl : (typeof it.url === "string" ? it.url : "");
                if (!dataUrl) return null;
                return {
                  id: typeof it.id === "string" && it.id ? it.id : genId(),
                  dataUrl,
                  refKey: typeof it.refKey === "string" ? it.refKey : "",
                  desc: typeof it.desc === "string" ? it.desc : "",
                };
              }
              return null;
            })
            .filter(Boolean) as GalleryItem[];
        } catch {
          return [];
        }
      };

      if (rawGallery) {
        try {
          setGalleryItems(parseGallery(rawGallery));
        } catch {
          setGalleryItems([]);
        }
      } else {
        setGalleryItems(parseGallery(presetGallery));
      }

      // lorebook
      // 우선순위: (로컬 초안이 'dirty'일 때만) 로컬 → 서버 preset.lorebooks
      const loreStorageKey = (storageKeys as any).lorebook as string;
      const loreDirtyKey = (storageKeys as any).lorebookDirty as string;
      const storedLore = localStorage.getItem(loreStorageKey) || "";
      const storedDirty = localStorage.getItem(loreDirtyKey) || "";
      const presetLore =
        typeof (selectedPreset as any)?.lorebooks === "string" ? String((selectedPreset as any).lorebooks) : "";

      const tryParseLore = (raw: string): LoreItem[] | null => {
        if (!raw) return null;
        try {
          const parsed = JSON.parse(String(raw));
          return Array.isArray(parsed) ? (parsed as LoreItem[]) : [];
        } catch {
          return null;
        }
      };

      const parsedStored = storedLore ? tryParseLore(storedLore) : null;
      const parsedPreset = presetLore ? tryParseLore(presetLore) : null;

      // dirty(=이 기기에서 수정 중)일 때만 로컬 초안을 최우선으로 본다.
      // - 다른 PC에서 오래된 로컬값(특히 '[]')이 서버 데이터를 가리는 문제를 방지
      let nextLore: LoreItem[] = [];

      if (storedDirty === "1") {
        // 로컬 초안이 깨져있으면 서버로 폴백
        if (parsedStored === null) {
          try { localStorage.removeItem(loreStorageKey); } catch {}
          try { localStorage.removeItem(loreDirtyKey); } catch {}
          nextLore = parsedPreset ?? [];
        } else {
          nextLore = parsedStored ?? [];
        }
      } else {
        // dirty가 아니면 서버가 있으면 서버를 우선
        if (parsedPreset && parsedPreset.length > 0) {
          nextLore = parsedPreset;
        } else if (parsedStored && parsedStored.length > 0) {
          // (레거시/이전 버전) dirty 키가 없는데 로컬에만 남아있는 경우 보호
          nextLore = parsedStored;
          try { localStorage.setItem(loreDirtyKey, "1"); } catch {}
        } else {
          nextLore = parsedPreset ?? parsedStored ?? [];
        }
      }

      setLoreItems(nextLore);
      // 로딩 직후에는 '수정됨'으로 취급하지 않음
      lorebooksTouchedRef.current = false;


// 공개 설정
      const storedPublic = localStorage.getItem(storageKeys.isPublic);
      if (storedPublic === "0" || storedPublic === "1") {
        setIsPublicLocal(storedPublic === "1");
      } else {
        // 서버에 저장된 값 (없으면 공개)
        const p = (selectedPreset as any)?.isPublic;
        const v = p === 0 || p === false ? false : true;
        setIsPublicLocal(v);
      }

      // NSFW 설정
      const storedNsfw = localStorage.getItem(storageKeys.isNsfw);
      if (storedNsfw === "0" || storedNsfw === "1") {
        setIsNsfwLocal(storedNsfw === "1");
      } else {
        const p = (selectedPreset as any)?.isNsfw;
        const v = p === 1 || p === true ? true : false;
        setIsNsfwLocal(v);
      }
    } catch {
      // ignore
    }
  }, [
    selectedPresetId,
    (selectedPreset as any)?.id,
    (selectedPreset as any)?.updatedAt,
    storageKeys.image,
    storageKeys.tags,
    storageKeys.target,
    storageKeys.gallery,
    storageKeys.firstMessage,
    (storageKeys as any).lorebook,
    storageKeys.isPublic,
    storageKeys.isNsfw,
  ]);

  // 드래프트 모드에서 공개/비공개 스위치를 누를 때만 isPublicLocal이 즉시 반영되도록 보조 동기화
  // (드래프트 제목/프롬프트 입력 등 draftPreset 변경으로 인해 로컬 상태들이 리셋되던 문제를 피하기 위해
  // 메인 effect에서는 draftPreset 전체를 의존성에 넣지 않습니다.)
  useEffect(() => {
    if (selectedPresetId) return;
    const v = (draftPreset as any).isPublic;
    if (v === 0 || v === 1) setIsPublicLocal(Boolean(v));
  }, [selectedPresetId, (draftPreset as any).isPublic]);

  useEffect(() => {
    if (selectedPresetId) return;
    const v = (draftPreset as any).isNsfw;
    if (v === 0 || v === 1) setIsNsfwLocal(Boolean(v));
  }, [selectedPresetId, (draftPreset as any).isNsfw]);

  function persistLocal(next: { image?: string; tags?: string; target?: TargetAudience; gallery?: GalleryItem[]; lorebook?: LoreItem[] }): boolean {
    try {
      if (typeof next.image === "string") localStorage.setItem(storageKeys.image, next.image);
      if (typeof next.tags === "string") localStorage.setItem(storageKeys.tags, next.tags);
      if (next.target) localStorage.setItem(storageKeys.target, next.target);
      if (next.gallery) localStorage.setItem(storageKeys.gallery, JSON.stringify(next.gallery));
      if (next.lorebook) {
        localStorage.setItem((storageKeys as any).lorebook, JSON.stringify(next.lorebook));
        // 로어북은 기기별 로컬 초안이 서버 데이터를 가릴 수 있어, 'dirty' 플래그로 제어한다.
        localStorage.setItem((storageKeys as any).lorebookDirty as string, "1");
      }
      return true;
    } catch (e) {
      // localStorage quota can be exceeded easily by image/base64 data.
      // We keep runtime state, but notify the user that refresh may lose data.
      console.warn("persistLocal failed", e);
      return false;
    }
  }

  function persistFirstMessage(next: string) {
    try {
      localStorage.setItem(storageKeys.firstMessage, next);
    } catch {
      // ignore
    }
  }

  async function handlePickImage(file: File) {
    try {
      const url = await compressImageFileToDataUrl(file, { maxDim: 768, quality: 0.78 });
      setImageDataUrl(url);
      const ok = persistLocal({ image: url });
      if (!ok) {
        showToast("저장 공간 부족", "브라우저 저장공간이 부족해서 이미지가 임시로만 유지될 수 있어요. (새로고침 시 사라질 수 있음)", "error");
      }
    } catch {
      showToast("이미지 처리 실패", "이미지를 불러오거나 압축하는 중 문제가 발생했어요.", "error");
    }
  }



  function genId() {
    try {
      return crypto.randomUUID();
    } catch {
      return Math.random().toString(16).slice(2) + Date.now().toString(16);
    }
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("file_read_failed"));
      reader.readAsDataURL(file);
    });
  }

  async function compressImageFileToDataUrl(
    file: File,
    opts: { maxDim: number; quality: number },
  ): Promise<string> {
    const raw = await readFileAsDataUrl(file);
    if (!raw.startsWith("data:image/")) return raw;

    // ✅ Preserve animated formats.
    // WebP(움짤) / GIF는 <canvas> 재인코딩 시 첫 프레임만 남아 애니메이션이 깨집니다.
    // 따라서 원본 dataURL을 그대로 저장해서(대표 이미지/갤러리) 작품 목록에서도 움직이게 합니다.
    try {
      const mime = (file && (file as any).type) ? String((file as any).type) : "";
      if (mime === "image/webp" || mime === "image/gif") return raw;
      if (raw.startsWith("data:image/webp") || raw.startsWith("data:image/gif")) return raw;
    } catch {
      // ignore
    }

    try {
      const img = new Image();
      img.decoding = "async";
      img.src = raw;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image_decode_failed"));
      });

      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) return raw;

      // (fix) 세로로 매우 긴 웹툰/스크롤 이미지(예: 높이 >> 너비)는
      // max(w,h) 기준으로 축소하면 너비가 과도하게 줄어(수십 px) 출력 시 심하게 흐릿해집니다.
      // - 일반 이미지는 기존처럼 긴 변(maxDim) 기준으로 축소
      // - '롱 스트립' 이미지는 너비 기준으로 축소하고, 높이는 브라우저 캔버스 한도 내에서만 제한
      const isLongStrip = h > w * 2.2;
      const MAX_CANVAS_SIDE = 16384;
      const maxH = Math.min(MAX_CANVAS_SIDE, opts.maxDim * 20);

      let scale = 1;
      if (isLongStrip) {
        scale = Math.min(1, opts.maxDim / w, maxH / h);
      } else {
        scale = Math.min(1, opts.maxDim / Math.max(w, h));
      }

      // (fix) 리사이즈가 필요 없고(=scale==1), 원본 dataURL이 충분히 작다면
      // 캔버스 재인코딩(손실압축)으로 텍스트/선이 흐려지는 걸 피하기 위해 원본을 그대로 둔다.
      if (scale >= 0.999 && raw.length <= 1_200_000) return raw;

      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));

      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) return raw;
      ctx.drawImage(img, 0, 0, cw, ch);

      const tryEncode = (mime: string, q: number) => {
        try {
          const out = canvas.toDataURL(mime, q);
          return out && out.startsWith(`data:${mime}`) ? out : "";
        } catch {
          return "";
        }
      };

      let out = tryEncode("image/webp", opts.quality) || tryEncode("image/jpeg", opts.quality) || raw;

      // Still too big? try a second pass with lower quality.
      if (out.length > 1_400_000) {
        const q2 = Math.max(0.6, opts.quality - 0.12);
        out = tryEncode("image/webp", q2) || tryEncode("image/jpeg", q2) || out;
      }

      return out;
    } catch {
      return raw;
    }
  }

  async function addGalleryFiles(files: FileList | File[]) {
    const list = Array.from(files || []);
    if (list.length == 0) return;

    const remaining = Math.max(0, 100 - galleryItems.length);
    const toAdd = list.slice(0, remaining);
    if (toAdd.length == 0) {
      showToast("알림", "갤러리는 최대 100장까지 가능합니다.", "info");
      return;
    }

    const newItems = [] as GalleryItem[];
    const existingKeys = new Set(galleryItems.map((g) => g.refKey).filter(Boolean));
    for (const f of toAdd) {
      const url = await compressImageFileToDataUrl(f, { maxDim: 640, quality: 0.74 });
      const refKey = randomRefKey(existingKeys);
      existingKeys.add(refKey);
      const desc = stripExtension(f.name || "");
      newItems.push({ id: genId(), dataUrl: url, refKey, desc });
    }

    const next = [...galleryItems, ...newItems];
    setGalleryItems(next);
    const ok = persistLocal({ gallery: next });
    if (!ok) {
      showToast(
        "저장 공간 부족",
        "브라우저 저장공간이 부족해 갤러리 이미지가 임시로만 유지될 수 있습니다. (새로고침/재접속 시 사라질 수 있어요)",
        "error",
      );
    }
  }

  function updateGalleryItem(id: string, patch: Partial<Pick<GalleryItem, "refKey" | "desc">>) {
    const next = galleryItems.map((it) => (it.id === id ? { ...it, ...patch } : it));
    setGalleryItems(next);
    persistLocal({ gallery: next });
  }

  function removeGalleryItem(id: string) {
    const next = galleryItems.filter((it) => it.id !== id);
    setGalleryItems(next);
    persistLocal({ gallery: next });
  }

  function moveGalleryItem(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    const next = [...galleryItems];
    const [picked] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, picked);
    setGalleryItems(next);
    persistLocal({ gallery: next });
  }
  // lorebook
  function addLoreItem() {
    lorebooksTouchedRef.current = true;
    if (loreItems.length >= 100) return;
    const id = cryptoRandomId();
    const next: LoreItem[] = [
      ...loreItems,
      { id, name: "", content: "", activationKeys: [], alwaysOn: false, isOpen: false },
    ];
    setLoreItems(next);
    persistLocal({ lorebook: next });
  }

  function deleteLoreItem(id: string) {
    lorebooksTouchedRef.current = true;
    const next = loreItems.filter((x) => x.id !== id);
    setLoreItems(next);
    persistLocal({ lorebook: next });
  }

  function moveLoreItem(fromIndex: number, toIndex: number) {
    lorebooksTouchedRef.current = true;
    if (fromIndex === toIndex) return;
    const next = [...loreItems];
    const [picked] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, picked);
    setLoreItems(next);
    persistLocal({ lorebook: next });
  }

  function toggleLoreOpen(id: string) {
    lorebooksTouchedRef.current = true;
    const next = loreItems.map((x) => (x.id === id ? { ...x, isOpen: !x.isOpen } : x));
    setLoreItems(next);
    persistLocal({ lorebook: next });
  }


function toggleLoreAlwaysOn(id: string) {
  lorebooksTouchedRef.current = true;
  const next = loreItems.map((x) => (x.id === id ? { ...x, alwaysOn: !x.alwaysOn } : x));
  setLoreItems(next);
  persistLocal({ lorebook: next });
}

  function updateLoreName(id: string, v: string, composing = false) {
    lorebooksTouchedRef.current = true;
    let s = v;
    if (!composing) {
      while (utf8Bytes(s) > 80) s = s.slice(0, -1);
    }
    const next = loreItems.map((x) => (x.id === id ? { ...x, name: s } : x));
    setLoreItems(next);
    if (!composing) persistLocal({ lorebook: next });
  }

  function updateLoreContent(id: string, v: string, composing = false) {
    lorebooksTouchedRef.current = true;
    let s = v;
    if (!composing) {
      while (utf8Bytes(s) > 4500) s = s.slice(0, -1);
    }
    const next = loreItems.map((x) => (x.id === id ? { ...x, content: s } : x));
    setLoreItems(next);
    if (!composing) persistLocal({ lorebook: next });
  }

  function addLoreKey(id: string, key: string) {
    lorebooksTouchedRef.current = true;
    const k = key.trim();
    if (!k) return;
    const next = loreItems.map((x) => {
      if (x.id !== id) return x;
      if (x.activationKeys.includes(k)) return x;
      return { ...x, activationKeys: [...x.activationKeys, k] };
    });
    setLoreItems(next);
    persistLocal({ lorebook: next });
  }

  function removeLoreKey(id: string, key: string) {
    lorebooksTouchedRef.current = true;
    const next = loreItems.map((x) => (x.id === id ? { ...x, activationKeys: x.activationKeys.filter((kk) => kk !== key) } : x));
    setLoreItems(next);
    persistLocal({ lorebook: next });
  }

  function cryptoRandomId() {
    try {
      // 6 chars like jTI0oS
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const buf = new Uint8Array(6);
      crypto.getRandomValues(buf);
      let out = "";
      for (let i = 0; i < 6; i++) out += chars[buf[i] % chars.length];
      return out;
    } catch {
      return Math.random().toString(36).slice(2, 8);
    }
  }

  // 기본정보: 이름(=characterName) / 소개말(=character)
  const [saving, setSaving] = useState(false);

  // 작업실 알림을 브라우저 alert 대신 앱 UI 토스트로 표출
  const [toast, setToast] = useState<null | { title: string; message: string; kind: "info" | "success" | "error" }>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback(
    (title: string, message: string, kind: "info" | "success" | "error" = "info") => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      setToast({ title, message, kind });
      // Workspace 내 토스트는 저장/검증 결과가 많아 가시성이 중요 → 종류별로 노출 시간을 다르게.
      // 요구사항: 모든 토스트는 5초 이내 자동 종료
      const ttl = Math.min(5000, kind === "error" ? 5200 : kind === "success" ? 3000 : 3600);
      toastTimerRef.current = window.setTimeout(() => setToast(null), ttl);
    },
    []
  );
  const saveTimer = useRef<number | null>(null);
  const lastSavedRef = useRef<{ name: string; intro: string } | null>(null);

  function scheduleSave(updated: Preset) {
    // ⚠️ 자동 저장은 비활성화.
    // - 입력 중에는 네트워크 저장을 하지 않고(연속 POST 방지)
    // - 하단 고정 "캐릭터 생성/수정" 버튼을 눌렀을 때만 저장한다.
    // 드래프트 상태에서는 로컬 상태만 갱신
    if (!selectedPresetId) {
      setDraftPreset(updated);
      return;
    }
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    // saving UI도 입력 중에는 켜지지 않도록 고정
    if (saving) setSaving(false);
  }

  function setCharacterName(nextName: string) {
  const base = selectedPreset || draftPreset;
  // 100 bytes 제한
  let s = nextName;
  while (utf8Bytes(s) > 100) s = s.slice(0, -1);
  // 작품 제목은 presets.name 이지만, 기존 호환을 위해 characterName도 함께 동기화
  const updated = { ...base, name: s, characterName: s };
  if (selectedPresetId) onUpdatePreset(updated);
  else setDraftPreset(updated);
  scheduleSave(updated);
}

  function setCharacterIntro(nextIntro: string) {
    const base = selectedPreset || draftPreset;
    const updated = { ...base, character: nextIntro };
    if (selectedPresetId) onUpdatePreset(updated); else setDraftPreset(updated);
    scheduleSave(updated);
  }

  function setSystemPrompt(nextPrompt: string) {
    const base = selectedPreset || draftPreset;
    // 20000 bytes 제한
    let s = nextPrompt;
    while (utf8Bytes(s) > 20000) s = s.slice(0, -1);
    const updated = { ...base, systemPrompt: s };
    if (selectedPresetId) onUpdatePreset(updated); else setDraftPreset(updated);
    scheduleSave(updated);
  }

  async function handleCreateCharacter() {
    const base = selectedPreset || draftPreset;

    const missing: string[] = [];
    if (!base.characterName?.trim()) missing.push("작품 제목");
    if (!(base.character || "").trim()) missing.push("캐릭터 소개말");
    if (!base.systemPrompt?.trim()) missing.push("프롬프트");
    if (!firstMessage?.trim()) missing.push("첫 메시지");

    if (missing.length > 0) {
      showToast("필수 항목", `필수 항목을 입력해주세요.\n- ${missing.join("\n- ")}`, "info");
      return;
    }

    try {
      const galleryJson = JSON.stringify(galleryItems.slice(0, 100));
      const firstMessagesJson = JSON.stringify([{ text: firstMessage.trim() }]);
      const lorebooksJson = JSON.stringify(loreItems.slice(0, 100).map((l, idx) => ({
        ...l,
        order: idx,
        isOpen: false,
      })));




        const payload: any = {
        ...(selectedPreset && selectedPreset.id && selectedPreset.id !== DRAFT_ID ? { id: selectedPreset.id } : {}),
        // 작품 리스트 카드에 보이는 대표 값들
        name: (base.name || base.characterName).trim(),
        background: (base.character || "").trim(),

        // 채팅 엔진에서 쓰는 값들
        characterName: base.characterName.trim(),
        characterAge: 0,
        character: (base.character || "").trim(),
        systemPrompt: (base.systemPrompt || "").trim(),

        // 작업실 확장 값들
        image: imageDataUrl || "",
        tags: tagsText || "",
        target: target || "all",
        gallery: galleryJson,
        firstMessages: firstMessagesJson,
        lorebooks: lorebooksJson,
        isPublic: (isPublicLocal ? 1 : 0),
        isNsfw: (isNsfwLocal ? 1 : 0),
      };

      const isEditing = Boolean(selectedPreset && selectedPreset.id && selectedPreset.id !== DRAFT_ID);

      const res = await fetch(isEditing ? "/api/preset/update" : "/api/preset/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }

      const json = await res.json();
      const created = (json?.preset ?? json) as Preset;
      onUpdatePreset(created);
      onSelectPreset(created.id ?? null);
      setView("list");
      if (!isEditing) {

      // 드래프트 초기화
      setDraftPreset({
        id: DRAFT_ID,
        name: "새 작품",
        background: "",
        characterName: "",
        characterAge: 0,
        character: "",
        systemPrompt: "",
        image: "",
        tags: "",
        target: "all",
        gallery: "[]",
        firstMessages: "[]",
        lorebooks: "[]",
        isPublic: 1,
        isNsfw: 0,
        createdAt: Date.now(),
      });
      setImageDataUrl("");
      setTagsText("");
      setTarget("all");
      setGalleryItems([]);
      setFirstMessage("");
      setLoreItems([]);
      loreDragIndexRef.current = null;

      }

      Object.values(storageKeys).forEach((k) => {
        try {
          window.localStorage.removeItem(k);
        } catch {}
      });
      try {
        window.localStorage.removeItem("workspace.draftPreset.v1");
      } catch {}

      showToast("완료", "캐릭터가 생성되었습니다. 작품 리스트에서 확인할 수 있습니다.", "success");
    } catch (err: any) {
      console.error(err);
      showToast("오류", `캐릭터 생성 중 오류가 발생했습니다.\n${err?.message || err}`, "error");
    }
  }

  async function handleUpdateCharacter() {
    if (!selectedPresetId) {
      // 편집 대상이 없으면 생성 흐름으로.
      await handleCreateCharacter();
      return;
    }

    const base = selectedPreset || draftPreset;

    const missing: string[] = [];
    if (!base.characterName?.trim()) missing.push("작품 제목");
    if (!(base.character || "").trim()) missing.push("캐릭터 소개말");
    if (!base.systemPrompt?.trim()) missing.push("프롬프트");
    if (!firstMessage?.trim()) missing.push("첫 메시지");

    if (missing.length > 0) {
      showToast("필수 항목", `필수 항목을 입력해주세요.\n- ${missing.join("\n- ")}`, "info");
      return;
    }

    try {
      const galleryJson = JSON.stringify(galleryItems.slice(0, 100));
      const firstMessagesJson = JSON.stringify([{ text: firstMessage.trim() }]);
      const lorebooksJson = JSON.stringify(
        loreItems
          .slice(0, 100)
          .map((l, idx) => ({
            ...l,
            order: idx,
            isOpen: false,
          }))
      );

      const payload: any = {
        ...(base as Preset),
        id: selectedPresetId,
        name: (base.name || base.characterName).trim(),
        background: (base.character || "").trim(),
        characterName: base.characterName.trim(),
        character: (base.character || "").trim(),
        systemPrompt: (base.systemPrompt || "").trim(),
        image: imageDataUrl || base.image || "",
        tags: tagsText || "",
        target: target || "all",
        gallery: galleryJson,
        firstMessages: firstMessagesJson,
        ...(lorebooksTouchedRef.current ? { lorebooks: lorebooksJson } : {}),
        isPublic: (isPublicLocal ? 1 : 0),
        isNsfw: (isNsfwLocal ? 1 : 0),
      };

      const res = await fetch("/api/preset/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json?.preset) {
        onUpdatePreset(json.preset);
        lorebooksTouchedRef.current = false;
        try { localStorage.removeItem((storageKeys as any).lorebookDirty as string); } catch {}
        showToast("완료", "캐릭터가 수정되었습니다.", "success");
      }
    } catch (err: any) {
      console.error(err);
      showToast("오류", `캐릭터 수정 중 오류가 발생했습니다.\n${err?.message || err}`, "error");
    }
  }

  function setFirstMessageLimited(nextMsg: string) {
    // 첫 메시지는 아직 DB/백엔드에 연결하지 않고(다음 요청에서 연결), 로컬에만 저장
    let s = nextMsg;
    while (utf8Bytes(s) > 5500) s = s.slice(0, -1);
    setFirstMessage(s);
    persistFirstMessage(s);
  }

  // scroll-follow when basic info grows (long intro)
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!el) return;
      if (isNearBottom(el)) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pillStyle = (active: boolean) => ({
    padding: "10px 16px",
    borderRadius: 999,
    border: `1px solid ${THEME.borderSoft}`,
    background: active ? "#4f46e5" : THEME.panel,
    color: THEME.text,
    cursor: "pointer",
    fontWeight: 800,
    fontSize: 13,
  } as const);

  const isEditing = !!selectedPresetId && selectedPresetId !== DRAFT_ID;
  const primaryActionLabel = isEditing ? "캐릭터 수정" : "캐릭터 생성";
  const primaryAction = isEditing ? handleUpdateCharacter : handleCreateCharacter;

  const cardStyle = {
    border: `1px solid ${THEME.border}`,
    background: THEME.panel2,
    borderRadius: 16,
    padding: 16,
  } as const;

  const activePreset = selectedPreset || draftPreset;
  const nameBytes = utf8Bytes((activePreset.name || activePreset.characterName) || "");

  const secondaryButtonStyle = {
    padding: "12px 14px",
    borderRadius: 12,
    border: `1px solid ${THEME.borderSoft}`,
    background: THEME.panel,
    color: THEME.text,
    cursor: "pointer",
    fontWeight: 800,
  } as const;

  const primaryButtonStyle = {
    padding: "12px 18px",
    borderRadius: 14,
    border: "none",
    background: "#4f46e5",
    color: "#fff",
    cursor: "pointer",
    fontWeight: 900,
  } as const;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 12, paddingBottom: 104 }}>
      {toast && (
        <div style={{ position: "fixed", left: "50%", bottom: "calc(16px + env(safe-area-inset-bottom, 0px) + 64px)", transform: "translateX(-50%)", zIndex: 9999, width: "min(560px, calc(100vw - 24px))", pointerEvents: "none" }}>
          <div
            onClick={() => setToast(null)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setToast(null);
            }}
            style={{
              pointerEvents: "auto",
              borderRadius: 18,
              border: `1px solid ${THEME.borderSoft}`,
              background: "rgba(10, 13, 20, 0.72)",
              backdropFilter: "blur(14px)",
              color: THEME.text,
              padding: "14px 14px",
              boxShadow: "0 18px 46px rgba(0,0,0,0.55)",
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              cursor: "pointer",
            }}
          >
            <div
              aria-hidden
              style={{
                width: 34,
                height: 34,
                borderRadius: 999,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "0 0 auto",
                background:
                  toast.kind === "success"
                    ? "rgba(79,70,229,0.22)"
                    : toast.kind === "error"
                      ? "rgba(239,68,68,0.18)"
                      : "rgba(59,130,246,0.18)",
                border:
                  toast.kind === "success"
                    ? "1px solid rgba(129,140,248,0.35)"
                    : toast.kind === "error"
                      ? "1px solid rgba(248,113,113,0.30)"
                      : "1px solid rgba(147,197,253,0.28)",
                color: toast.kind === "success" ? "#c7d2fe" : toast.kind === "error" ? "#fecaca" : "#bfdbfe",
                fontWeight: 1000,
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              {toast.kind === "success" ? "✓" : toast.kind === "error" ? "!" : "i"}
            </div>

            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontWeight: 950, fontSize: 14, letterSpacing: "0.01em" }}>{toast.title}</div>
                <div
                  style={{
                    flex: "0 0 auto",
                    fontSize: 11,
                    fontWeight: 900,
                    padding: "4px 8px",
                    borderRadius: 999,
                    border: `1px solid ${THEME.borderSoft}`,
                    background: "rgba(255,255,255,0.06)",
                    color: toast.kind === "success" ? "#c7d2fe" : toast.kind === "error" ? "#fecaca" : "#bfdbfe",
                    userSelect: "none",
                  }}
                >
                  {toast.kind === "success" ? "저장 완료" : toast.kind === "error" ? "실패" : "안내"}
                </div>
              </div>
              <div style={{ marginTop: 6, whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14, opacity: 0.95 }}>{toast.message}</div>
              <div style={{ marginTop: 10, fontSize: 11, opacity: 0.72, userSelect: "none" }}>클릭하면 닫힙니다</div>
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setToast(null);
              }}
              aria-label="토스트 닫기"
              style={{
                pointerEvents: "auto",
                border: `1px solid ${THEME.borderSoft}`,
                background: "rgba(255,255,255,0.06)",
                color: THEME.text,
                borderRadius: 12,
                padding: "8px 10px",
                cursor: "pointer",
                fontWeight: 900,
                lineHeight: 1,
                flex: "0 0 auto",
              }}
            >
              ×
            </button>
          </div>
        </div>
      )}
      {view === "list" ? (
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "0 12px 24px", width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6, marginBottom: 12 }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>생성한 캐릭터</div>
            <button
              type="button"
              onClick={() => {
                // 새 캐릭터 만들기 (새 Draft)
                onSelectPreset(null);
                setTab("basic");
                setView("edit");
                // Draft 초기화
                setDraftPreset(() => ({
                  id: DRAFT_ID,
                  name: "",
                  characterName: "",
                  character: "",
                  tags: "",
                  target: "all",
                  image: "",
                  gallery: "[]",
                  prompt: "",
                  systemPrompt: "",
                  firstMessages: '[""]',
                  lorebooks: "[]",
                  version: 1,
                  createdAt: Date.now(),
                }));
                setImageDataUrl("");
                setTagsText("");
                setTarget("all");
                setGalleryItems([]);
                setLoreItems([]);
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 12,
                border: `1px solid ${THEME.borderSoft}`,
                background: "#ffffff",
                color: "#111827",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              + 새 캐릭터 만들기
            </button>
          </div>

          {presets.length === 0 ? (
            <div
              style={{
                height: 520,
                borderRadius: 18,
                border: `1px solid ${THEME.borderSoft}`,
                background: THEME.panel,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div style={{ textAlign: "center", opacity: 0.9 }}>
                <div style={{ fontSize: 44, lineHeight: 1 }}>🧑‍🤝‍🧑</div>
                <div style={{ marginTop: 10, fontSize: 16, fontWeight: 900 }}>생성한 캐릭터가 없습니다.</div>
                <div style={{ marginTop: 6, fontSize: 13, opacity: 0.75 }}>새로운 AI 캐릭터를 만들어보세요!</div>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                // desktop 기준 4열에 가깝게 보이도록 최소 폭을 낮춥니다.
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 14,
              }}
            >
              {presets.map((p) => (
                <div
                  key={p.id}
                  style={{
                    textAlign: "left",
                    borderRadius: 18,
                    border: `1px solid ${THEME.borderSoft}`,
                    background: THEME.panel,
                    padding: 12,
                    color: THEME.text,
                    cursor: "default",
                    userSelect: "none",
                  }}
                >
                  <div
                    style={{
                      borderRadius: 14,
                      border: `1px solid ${THEME.borderSoft}`,
                      background: "rgba(255,255,255,0.02)",
                      width: "100%",
                      aspectRatio: "3 / 4",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    {p.image ? (
                      <img
                        src={p.image}
                        alt={p.characterName || p.name}
	                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        draggable={false}
                        onError={(e) => {
                          // 엑박 대신 기본 로고로 폴백
                          const img = e.currentTarget as HTMLImageElement;
                          if (img && img.src && !img.src.endsWith("/arca-headset.png")) img.src = "/arca-headset.png";
                        }}
                      />
                    ) : (
                      <div style={{ opacity: 0.6, fontSize: 12 }}>No Image</div>
                    )}
                  </div>

                  <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 16, fontWeight: 900, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.characterName || p.name || "이름 없음"}
                    </div>
                    {(p as any).isNsfw ? (
                      <div
                        style={{
                          fontSize: 12,
                          padding: "4px 8px",
                          borderRadius: 999,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: THEME.panel2,
                          // 더 '빨간' 느낌으로 (요청)
                          color: "#ff4d4f",
                          fontWeight: 900,
                          flex: "0 0 auto",
                        }}
                        title="성인 콘텐츠"
                      >
                        19+
                      </div>
                    ) : null}
                  </div>
	                  {/* 카드 설명은 고정 줄 수로 잘라서(… 처리) 카드 높이를 일정하게 유지 */}
	                  <div
	                    style={{
	                      marginTop: 6,
	                      fontSize: 13,
	                      opacity: 0.8,
	                      // 2줄까지만 노출 (다른 카드들과 높이 맞춤)
	                      display: "-webkit-box",
			                      WebkitLineClamp: 2,
			                      WebkitBoxOrient: "vertical",
	                      overflow: "hidden",
	                      textOverflow: "ellipsis",
	                      whiteSpace: "normal",
	                      lineHeight: 1.45,
	                      // lineHeight(1.45) * 2줄 = 약 38px
	                      height: 38,
	                    }}
	                    title={(p.character || "").trim()}
	                  >
	                    {p.character || ""}
	                  </div>

                  {/* 액션 버튼: 채팅하기(상단) + 수정/삭제(하단) */}
                  <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => openChatForPreset(p.id)}
                      style={{
                        height: 42,
                        borderRadius: 14,
                        border: `1px solid ${THEME.borderSoft}`,
                        background: "linear-gradient(90deg, rgba(168,85,247,0.35), rgba(59,130,246,0.18))",
                        color: "#eef2ff",
                        cursor: "pointer",
                        fontWeight: 950,
                        letterSpacing: 0.2,
                        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
                      }}
                      title="채팅하기"
                    >
                      💬 채팅하기
                    </button>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectPreset(p.id);
                          setTab("basic");
                          setView("edit");
                        }}
                        style={{
                          height: 40,
                          borderRadius: 14,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: THEME.panel2,
                          color: THEME.text,
                          cursor: "pointer",
                          fontWeight: 900,
                        }}
                        title="수정"
                      >
                        ✏️ 수정
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const ok = confirm("이 캐릭터를 삭제할까요?\n(삭제하면 복구할 수 없습니다.)");
                          if (!ok) return;
                          onDeletePreset(p.id);
                        }}
                        style={{
                          height: 40,
                          borderRadius: 14,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: "rgba(239,68,68,0.12)",
                          color: "#fecaca",
                          cursor: "pointer",
                          fontWeight: 900,
                        }}
                        title="삭제"
                      >
                        🗑 삭제
                      </button>
                    </div>
                  </div>

                  {(p.tags || "").trim() ? (
                    <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {(p.tags || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 6).map((t) => (
                        <span
                          key={t}
                          style={{
                            fontSize: 11,
                            padding: "4px 8px",
                            borderRadius: 999,
                            border: `1px solid ${THEME.borderSoft}`,
                            background: THEME.panel2,
                            opacity: 0.9,
                          }}
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>

      {/* workspace header + sub tabs */}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 6, borderRadius: 999, border: `1px solid ${THEME.borderSoft}`, background: THEME.panel }}>
          <button onClick={() => setTab("basic")} style={pillStyle(tab === "basic")}>기본 정보</button>
          <button onClick={() => setTab("gallery")} style={pillStyle(tab === "gallery")}>갤러리</button>
          <button onClick={() => setTab("detail")} style={pillStyle(tab === "detail")}>상세 설정</button>
          <button onClick={() => setTab("lorebook")} style={pillStyle(tab === "lorebook")}>로어북</button>
        </div>

        {/* 우측 상단의 '선택 작품/삭제' UI는 작업실(신규 생성 화면)에서는 숨김 */}
      </div>

      {/* content */}
      <div ref={scrollRef} style={{ flex: 1, overflow: "auto" }}>
        {tab === "basic" ? (
          <div
            style={{
              maxWidth: 760,
              margin: "0 auto",
              padding: "0 12px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            {/* 메인 이미지 */}
            <div style={{ ...cardStyle }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>메인 이미지 <span style={{ color: "#a5b4fc" }}>*</span></div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handlePickImage(f);
                  e.currentTarget.value = "";
                }}
              />
              <div style={{ display: "flex", justifyContent: "center" }}>
                <div
                  onClick={() => fileRef.current?.click()}
                  style={{
                    width: 280,
                    height: 280,
                    borderRadius: 18,
                    border: `2px dashed ${THEME.borderSoft}`,
                    background: THEME.panel2,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    position: "relative",
                    overflow: "hidden",
                  }}
                  title="클릭해서 업로드"
                >
                {imageDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageDataUrl}
                    alt="main"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      background: THEME.panel2,
                    }}
                  />
                ) : (
                  <div style={{ textAlign: "center", opacity: 0.7 }}>
                    <div style={{ fontSize: 36, marginBottom: 8 }}>🖼️</div>
                    <div style={{ fontSize: 13 }}>이미지를 업로드하세요</div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>로컬 PC 파일 선택</div>
                  </div>
                )}
                </div>
              </div>
              {imageDataUrl ? (
                <div style={{ marginTop: 12, display: "flex", gap: 10, justifyContent: "center" }}>
                  <button
                    onClick={() => fileRef.current?.click()}
                    style={secondaryButtonStyle}
                  >
                    이미지 변경
                  </button>
                  <button
                    onClick={() => {
                      setImageDataUrl("");
                      persistLocal({ image: "" });
                    }}
                    style={{ ...secondaryButtonStyle, background: "transparent" }}
                  >
                    제거
                  </button>
                </div>
              ) : null}
            </div>

            {/* 기본 정보 */}
            <div style={{ ...cardStyle }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>기본 정보</div>
              <div style={{ fontSize: 13, marginBottom: 8, opacity: 0.85 }}>작품 제목 <span style={{ color: "#a5b4fc" }}>*</span></div>
              <input
                value={(activePreset.name || activePreset.characterName) || ""}
                onChange={(e) => setCharacterName(e.target.value)}
                placeholder="작품 제목 입력..."
                style={{
                  width: "100%",
                  padding: "12px 12px",
                  borderRadius: 12,
                  border: `1px solid ${THEME.borderSoft}`,
                  background: THEME.panel2,
                  color: THEME.text,
                  outline: "none",
                }}
              />
              <div style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{nameBytes}/100 B</div>
                {saving ? <div style={{ fontSize: 12, opacity: 0.7 }}>저장 중...</div> : null}
              </div>
            </div>

            {/* 캐릭터 소개말 */}
            <div style={{ ...cardStyle }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>캐릭터 소개말 <span style={{ color: "#a5b4fc" }}>*</span></div>
              <textarea
                value={activePreset.character || ""}
                onChange={(e) => setCharacterIntro(e.target.value)}
                placeholder="캐릭터에 대한 소개를 간략하게 작성해 주세요."
                rows={6}
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 12,
                  border: `1px solid ${THEME.borderSoft}`,
                  background: THEME.panel2,
                  color: THEME.text,
                  outline: "none",
                  resize: "vertical",
                }}
              />
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>{utf8Bytes(activePreset.character || "")}/12000 B</div>
            </div>

            
            {/* 태그 */}
            <div style={{ ...cardStyle }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>태그</div>

              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  placeholder="태그 작성 후 Enter (예: 공포, 범죄)"
                  style={{
                    flex: 1,
                    padding: "12px 12px",
                    borderRadius: 12,
                    border: `1px solid ${THEME.borderSoft}`,
                    background: THEME.panel2,
                    color: THEME.text,
                    outline: "none",
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTagsFromInput(tagDraft);
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => addTagsFromInput(tagDraft)}
                  style={{
                    width: 70,
                    height: 42,
                    borderRadius: 12,
                    border: `1px solid ${THEME.borderSoft}`,
                    background: THEME.panel,
                    color: THEME.text,
                    fontWeight: 800,
                  }}
                >
                  추가
                </button>
              </div>

              {tags.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                  {tags.map((t) => (
                    <div
                      key={t}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: `1px solid ${THEME.borderSoft}`,
                        background: THEME.panel,
                        fontSize: 12,
                      }}
                    >
                      <span>{t}</span>
                      <button
                        type="button"
                        onClick={() => removeTag(t)}
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: 999,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: "transparent",
                          color: "#ef4444",
                          lineHeight: "16px",
                        }}
                        title="삭제"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* 기존 데이터 호환: tagsText는 comma-separated로 유지 */}
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>{utf8Bytes(tagsText || "")} B</div>
            </div>

{/* 타겟 유저층 */}
            <div style={{ ...cardStyle }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>타겟 유저층</div>
              <div style={{ display: "flex", gap: 10, background: THEME.panel2, border: `1px solid ${THEME.borderSoft}`, borderRadius: 999, padding: 6 }}>
                <button
                  onClick={() => {
                    setTarget("all");
                    persistLocal({ target: "all" });
                  }}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    background: target === "all" ? "#4f46e5" : "transparent",
                    color: THEME.text,
                    fontWeight: 900,
                  }}
                >
                  전체
                </button>
                <button
                  onClick={() => {
                    setTarget("male");
                    persistLocal({ target: "male" });
                  }}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    background: target === "male" ? "#4f46e5" : "transparent",
                    color: THEME.text,
                    fontWeight: 900,
                  }}
                >
                  남성향
                </button>
                <button
                  onClick={() => {
                    setTarget("female");
                    persistLocal({ target: "female" });
                  }}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    background: target === "female" ? "#4f46e5" : "transparent",
                    color: THEME.text,
                    fontWeight: 900,
                  }}
                >
                  여성향
                </button>
              </div>
            </div>

            {/* 공개/비공개 (리스트 노출) */}
            <div style={{ ...cardStyle }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>공개 설정</div>
              <div style={{ display: "flex", gap: 10, background: THEME.panel2, border: `1px solid ${THEME.borderSoft}`, borderRadius: 999, padding: 6 }}>
                <button
                  type="button"
                  onClick={() => setIsPublic(true)}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    background: isPublicLocal ? "#4f46e5" : "transparent",
                    color: THEME.text,
                    fontWeight: 900,
                  }}
                >
                  공개
                </button>
                <button
                  type="button"
                  onClick={() => setIsPublic(false)}
                  style={{
                    flex: 1,
                    padding: "10px 12px",
                    borderRadius: 999,
                    border: "none",
                    cursor: "pointer",
                    background: !isPublicLocal ? "#4f46e5" : "transparent",
                    color: THEME.text,
                    fontWeight: 900,
                  }}
                >
                  비공개
                </button>
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: THEME.muted, lineHeight: 1.5 }}>
                공개: 비로그인 포함 누구나 작품 리스트에서 볼 수 있어요. · 비공개: 본인만 볼 수 있어요.
              </div>

              {/* 제작/수정 모드 표시 (요청 UX) */}
              <div style={{ marginTop: 10, fontSize: 12, color: THEME.muted }}>
                현재 모드: <span style={{ fontWeight: 900, color: THEME.text }}>{selectedPresetId ? "수정 모드" : "제작 모드"}</span>
              </div>
            </div>

            {/* 성인 콘텐츠(NSFW) */}
            <div style={{ ...cardStyle }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontWeight: 900 }}>성인 콘텐츠</div>
                    <div
                      style={{
                        fontSize: 12,
                        padding: "4px 8px",
                        borderRadius: 999,
                        border: `1px solid ${THEME.borderSoft}`,
                        background: THEME.panel,
                        opacity: 0.9,
                        // 더 '빨간' 느낌으로 (요청)
                        color: "#ff4d4f",
                        fontWeight: 900,
                      }}
                    >
                      19+
                    </div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: THEME.muted, lineHeight: 1.5 }}>
                    해당 캐릭터가 NSFW(성인) 콘텐츠인지 표시합니다.
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setIsNsfw(!isNsfwLocal)}
                  aria-label={isNsfwLocal ? "성인 콘텐츠 ON" : "성인 콘텐츠 OFF"}
                  style={{
                    width: 56,
                    height: 30,
                    borderRadius: 999,
                    border: `1px solid ${THEME.borderSoft}`,
                    background: isNsfwLocal ? "#4f46e5" : THEME.panel2,
                    padding: 3,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: isNsfwLocal ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      background: "#ffffff",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
                    }}
                  />
                </button>
              </div>
            </div>

	            {/* 저장/수정은 하단 고정 바에서만 실행 */}
          </div>
        ) : tab === "gallery" ? (
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 12px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ ...cardStyle, position: "relative" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 900 }}>갤러리</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                    대화 중 사용할 추가 이미지를 업로드하세요. (추후 지시에서 {"{{img:참조키}}"} 형식으로 참조할 수 있습니다)
                  </div>
                </div>
                <div style={{ fontSize: 12, opacity: 0.85, padding: "6px 10px", borderRadius: 999, border: `1px solid ${THEME.borderSoft}`, background: THEME.panel2 }}>
                  {galleryItems.length}/100
                </div>
              </div>

              <input
                ref={galleryFileRef}
                type="file"
                accept="image/*"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length) addGalleryFiles(files);
                  e.currentTarget.value = "";
                }}
              />

              <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", marginTop: 10 }}>
                <button
                  type="button"
                  onClick={() => galleryFileRef.current?.click()}
                  style={secondaryButtonStyle}
                >
                  이미지 추가
                </button>
                <div style={{ fontSize: 12, opacity: 0.65 }}>
                  최대 100장 · 이미지 파일만
                </div>
              </div>

              {galleryItems.length === 0 ? (
                <div style={{ marginTop: 14, padding: 18, borderRadius: 14, border: `1px dashed ${THEME.borderSoft}`, background: THEME.panel, opacity: 0.75 }}>
                  아직 등록된 이미지가 없습니다. <b>이미지 추가</b>로 업로드해 주세요.
                </div>
              ) : (
                <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                  {galleryItems.map((it, idx) => (
                    <div
                      key={it.id}
                      onDragOver={(e) => {
                        e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const from = dragIndexRef.current;
                        if (from == null) return;
                        moveGalleryItem(from, idx);
                        dragIndexRef.current = null;
                      }}
                      style={{
                        display: "flex",
                        gap: 12,
                        padding: 12,
                        borderRadius: 14,
                        border: `1px solid ${THEME.borderSoft}`,
                        background: THEME.panel,
                      }}
                    >
                      <div style={{ width: 108, flex: "0 0 108px" }}>
                        <div style={{ width: 108, height: 108, borderRadius: 12, overflow: "hidden", border: `1px solid ${THEME.borderSoft}`, background: THEME.panel2, display: "flex", alignItems: "center", justifyContent: "center" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={it.dataUrl} alt="gallery" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                        </div>
                      </div>

                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            #{idx + 1}
                          </div>
                          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                            <div
                              draggable
                              onDragStart={() => {
                                dragIndexRef.current = idx;
                              }}
                              onDragEnd={() => {
                                dragIndexRef.current = null;
                              }}
                              title="드래그해서 순서 변경"
                              style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 10px", borderRadius: 999, border: `1px solid ${THEME.borderSoft}`, background: THEME.panel2, cursor: "grab", userSelect: "none" }}
                            >
                              <span style={{ fontSize: 12, opacity: 0.85 }}>Drag</span>
                              <span style={{ opacity: 0.7 }}>⠿</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeGalleryItem(it.id)}
                              title="삭제"
                              style={{ padding: "8px 10px", borderRadius: 12, border: `1px solid ${THEME.borderSoft}`, background: "transparent", color: "#ef4444", cursor: "pointer", fontWeight: 900 }}
                            >
                              🗑
                            </button>
                          </div>
                        </div>

                        <div>
                          <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.85, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                            <span>참조 키</span>
                            <button
                              type="button"
                              onClick={() => {
                                const existing = new Set(galleryItems.map((g) => g.refKey).filter(Boolean));
                                existing.delete(it.refKey);
                                const k = randomRefKey(existing);
                                updateGalleryItem(it.id, { refKey: k });
                              }}
                              style={{ padding: "6px 10px", borderRadius: 999, border: `1px solid ${THEME.borderSoft}`, background: THEME.panel2, color: THEME.text, cursor: "pointer", fontWeight: 900, fontSize: 12 }}
                              title="6글자 랜덤 생성"
                            >
                              랜덤 생성
                            </button>
                          </div>
                          <input
                            value={it.refKey}
                            onChange={(e) => {
                              // 6글자 제한 + 영문/숫자만
                              const cleaned = e.target.value.replace(/[^a-z0-9]/gi, "").slice(0, 6);
                              updateGalleryItem(it.id, { refKey: cleaned });
                            }}
                            placeholder="예: jTI0oS"
                            maxLength={6}
                            style={{ width: "100%", padding: "10px 12px", borderRadius: 12, border: `1px solid ${THEME.borderSoft}`, background: THEME.panel2, color: THEME.text, outline: "none" }}
                          />
                        </div>

                        <div>
                          <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.85, fontWeight: 800, display: "flex", justifyContent: "space-between" }}>
                            <span>설명</span>
                            <span style={{ opacity: 0.6 }}>{(it.desc || "").length} / 80</span>
                          </div>
                          <textarea
                            value={it.desc}
                            onChange={(e) => updateGalleryItem(it.id, { desc: e.target.value.slice(0, 80) })}
                            placeholder="예: 입사원피스정장"
                            rows={2}
                            style={{ width: "100%", padding: 12, borderRadius: 12, border: `1px solid ${THEME.borderSoft}`, background: THEME.panel2, color: THEME.text, outline: "none", resize: "vertical" }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

	            {/* 저장/수정은 하단 고정 바에서만 실행 */}
          </div>
        ) : tab === "detail" ? (
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 12px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            {/* 프롬프트 */}
            <div style={{ ...cardStyle }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div style={{ fontWeight: 900 }}>프롬프트 <span style={{ color: "#a5b4fc" }}>*</span></div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{utf8Bytes(activePreset.systemPrompt || "")}/20000 B</div>
              </div>
              <textarea
                value={activePreset.systemPrompt || ""}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="캐릭터 외형, 성격, 배경, 이야기 등을 작성해주세요."
                rows={10}
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 12,
                  border: `1px solid ${THEME.borderSoft}`,
                  background: THEME.panel2,
                  color: THEME.text,
                  outline: "none",
                  resize: "vertical",
                  minHeight: 240,
                }}
              />
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>프롬프트는 최대 20000B까지 입력할 수 있습니다.</div>
            </div>

	            {/* roster-only 인물 기억 */}
<div style={{ fontSize: 12, color: THEME.muted, marginTop: -4 }}>
              ※ 공개 설정/성인 콘텐츠는 ‘기본 설정’ 탭에서 변경해요.
            </div>

            {/* 첫 메시지 */}
            <div style={{ ...cardStyle }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 900 }}>첫 메시지 <span style={{ color: "#a5b4fc" }}>*</span></div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>캐릭터가 대화를 시작할 때 보내는 첫 메시지를 설정하세요.</div>
                </div>
                <button
                  type="button"
                  onClick={() => showToast("알림", "다중 첫 메시지는 다음 요청에서 추가할게요.", "info")}
                  style={{ padding: "8px 12px", borderRadius: 12, border: `1px solid ${THEME.borderSoft}`, background: THEME.panel2, color: THEME.text, cursor: "pointer", fontWeight: 900, fontSize: 12 }}
                  title="추후 기능"
                >
                  + 첫 메시지 추가
                </button>
              </div>

              <textarea
                value={firstMessage}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={(e) => {
                  composingRef.current = false;
                  let s = e.currentTarget.value;
                  while (utf8Bytes(s) > 5500) s = s.slice(0, -1);
                  setFirstMessage(s);
                  persistFirstMessage(s);
                }}
                onChange={(e) => {
                  let s = e.target.value;
                  if (composingRef.current) {
                    setFirstMessage(s);
                    return;
                  }
                  while (utf8Bytes(s) > 5500) s = s.slice(0, -1);
                  setFirstMessage(s);
                  persistFirstMessage(s);
                }}
                  placeholder="캐릭터가 대화를 시작할 때 보내는 첫 메시지를 설정하세요."
                rows={6}
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 12,
                  border: `1px solid ${THEME.borderSoft}`,
                  background: THEME.panel2,
                  color: THEME.text,
                  outline: "none",
                  resize: "vertical",
                  minHeight: 180,
                }}
              />
              <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{utf8Bytes(firstMessage)}/5500 B</div>
                <div style={{ fontSize: 12, opacity: 0.6 }}>※ 캐릭터 생성 시 함께 저장됩니다.</div>
              </div>
            </div>

	            {/* 저장/수정은 하단 고정 바에서만 실행 */}
	          </div>
	        ) : (
	          <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 12px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ ...cardStyle }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>로어북 만들기</div>
              <div style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.6 }}>
                로어북을 사용하여 더욱 생동감 있는 캐릭터를 만들어보세요. (최대 100개)
                <br />• 기본은 "키 매칭된 로어"만 포함됩니다. (매칭 0개면 로어북을 프롬프트에 넣지 않음)
                <br />• "상시 포함" 체크된 로어는 키가 없어도 포함되며, 상단 5개만 상시로 처리됩니다.
                <br />• 우선순위: 상시 포함(상단 5개) → 최근 채팅에서 활성화 키 등장(최대 12개)
              </div>
            </div>

            {loreItems.map((it, idx) => (
              <div
                key={it.id}
                // 로어 편집 중(펼친 상태)에는 드래그를 꺼서
                // IME(한글) 조합 중 값이 날아가거나 마지막 글자가 누락되는 현상을 방지
                draggable={!it.isOpen}
                onDragStart={() => {
                  if (it.isOpen) return;
                  loreDragIndexRef.current = idx;
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = loreDragIndexRef.current;
                  if (from == null) return;
                  moveLoreItem(from, idx);
                  loreDragIndexRef.current = null;
                }}
                style={{ ...cardStyle, padding: 0, overflow: "hidden" }}
              >
                <div
                  style={{
                    padding: "14px 14px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    cursor: it.isOpen ? "default" : "grab",
                  }}
                >
                  <div style={{ fontWeight: 900, display: "flex", alignItems: "center", gap: 8 }}>
                    <div>로어 #{idx + 1}</div>
                    {it.alwaysOn ? (
                      <span
                        style={{
                          fontSize: 11,
                          padding: "3px 8px",
                          borderRadius: 999,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: "rgba(99,102,241,0.14)",
                          color: "#a5b4fc",
                          fontWeight: 900,
                        }}
                      >
                        상시
                      </span>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>Drag</div>
                    <div style={{ opacity: 0.75 }}>⋮⋮</div>
                    <button
                      type="button"
                      onClick={() => toggleLoreOpen(it.id)}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 10,
                        border: `1px solid ${THEME.borderSoft}`,
                        background: THEME.panel,
                        color: THEME.text,
                      }}
                      title={it.isOpen ? "접기" : "펼치기"}
                    >
                      {it.isOpen ? "˄" : "˅"}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteLoreItem(it.id)}
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 10,
                        border: `1px solid ${THEME.borderSoft}`,
                        background: THEME.panel,
                        color: "#ef4444",
                      }}
                      title="삭제"
                    >
                      ×
                    </button>
                  </div>
                </div>

                {it.isOpen ? (
                  <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
                    <div>
                      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>로어 이름</div>
                      <input
                        value={it.name}
                        onCompositionStart={() => { composingRef.current = true; }}
                        onCompositionEnd={(e) => {
                          composingRef.current = false;
                          updateLoreName(it.id, e.currentTarget.value, false);
                        }}
                        onChange={(e) => updateLoreName(it.id, e.target.value, composingRef.current)}
                        placeholder="로어 이름을 작성해 주세요."
                        style={{
                          width: "100%",
                          padding: "12px 12px",
                          borderRadius: 12,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: THEME.panel2,
                          color: THEME.text,
                          outline: "none",
                        }}
                      />
                      <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>{utf8Bytes(it.name || "")}/80 B</div>
                    </div>

                    <div>
                      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>로어 내용</div>
                      <textarea
                        value={it.content}
                        onCompositionStart={() => { composingRef.current = true; }}
                        onCompositionEnd={(e) => {
                          composingRef.current = false;
                          updateLoreContent(it.id, e.currentTarget.value, false);
                        }}
                        onChange={(e) => updateLoreContent(it.id, e.target.value, composingRef.current)}
                        placeholder="로어 내용을 작성해 주세요."
                        rows={6}
                        style={{
                          width: "100%",
                          padding: "12px 12px",
                          borderRadius: 12,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: THEME.panel2,
                          color: THEME.text,
                          outline: "none",
                          resize: "vertical",
                        }}
                      />
                      <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>{utf8Bytes(it.content || "")}/4500 B</div>
                    </div>


<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
  <input
    type="checkbox"
    checked={Boolean(it.alwaysOn)}
    onChange={() => toggleLoreAlwaysOn(it.id)}
  />
  <div style={{ fontSize: 13, opacity: 0.85, fontWeight: 800 }}>상시 포함 (상단 5개)</div>
  <div style={{ fontSize: 12, opacity: 0.6 }}>
    체크 시 키 매칭이 없어도 프롬프트에 포함됩니다. (상시가 6개 이상이면 상단 5개만 상시 적용)
  </div>
</div>
                    <div>
                      <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>활성화 키</div>
                      <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>
                        설정한 키가 최근 3 대화에 포함 되는 경우 로어가 활성화 됩니다.
                      </div>

                      <LoreKeyEditor
                        theme={THEME}
                        keys={it.activationKeys}
                        onAdd={(k) => addLoreKey(it.id, k)}
                        onRemove={(k) => removeLoreKey(it.id, k)}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            ))}

            <button
              type="button"
              onClick={addLoreItem}
              style={{
                height: 46,
                borderRadius: 14,
                border: `1px solid ${THEME.borderSoft}`,
                background: "rgba(99,102,241,0.12)",
                color: "#a5b4fc",
                fontWeight: 800,
              }}
            >
              ＋ 로어 추가하기
            </button>
          </div>
        )}

        {/* sticky primary action (create/update)
            - scroll 영역 안에 붙여서 "따라오는" 느낌
            - 바(bar) 폭을 컨텐츠(maxWidth:760)와 맞춰서 색/길이 튀는 느낌 제거 */}
        <div
          style={{
            position: "sticky",
            bottom: "calc(12px + env(safe-area-inset-bottom, 0px))",
            zIndex: 60,
            padding: "0 12px 12px",
            marginTop: 14,
          }}
        >
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <div
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
                flexWrap: "wrap",
                padding: "14px 16px",
                borderRadius: 18,
                border: `1px solid ${THEME.borderSoft}`,
                background: "rgba(10, 13, 20, 0.66)",
                backdropFilter: "blur(14px)",
                boxShadow: "0 16px 44px rgba(0,0,0,0.55)",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                  minWidth: 0,
                  flexWrap: "wrap",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    padding: "5px 10px",
                    borderRadius: 999,
                    border: `1px solid ${THEME.borderSoft}`,
                    background: THEME.panel2,
                    fontWeight: 900,
                    whiteSpace: "nowrap",
                    opacity: 0.92,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <span aria-hidden>{isEditing ? "🛠" : "✨"}</span>
                  {selectedPresetId ? "수정" : "제작"}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    opacity: 0.82,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 420,
                  }}
                >
                  {saving ? "저장 중…" : isEditing ? "변경사항을 저장하세요." : "캐릭터를 생성합니다."}
                </div>
              </div>

              <button
                type="button"
                style={{
                  ...primaryButtonStyle,
                  opacity: saving ? 0.85 : 1,
                  minWidth: 180,
                }}
                onClick={primaryAction}
                disabled={saving}
              >
                {primaryActionLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
        </>
      )}

    </div>
  );
}