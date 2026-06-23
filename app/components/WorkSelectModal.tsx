"use client";

import React, { useEffect, useMemo, useState } from "react";

type Preset = {
  id: string;
  userEmail?: string;
  name: string;
  characterName?: string;
  background?: string;
  desc?: string;
  image?: string;
  gallery?: string;
  tags?: string;
  target?: string;
  // DB presets 테이블
  createdAt?: number;
  character?: string;
};

type PresetMeta = {
  views: number;
  likeCount: number;
  followCount: number;
  chatCount: number;
  likedByMe: boolean;
  followedByMe: boolean;
};

type PresetCreator = {
  email: string | null;
  nickname: string | null;
  name: string | null;
  image: string | null;
};

type PresetComment = {
  id: string;
  presetId: string;
  userEmail: string;
  // Optional user profile fields (nickname/avatar) returned by the API.
  userNickname?: string | null;
  userImage?: string | null;
  content: string;
  createdAt: number;
  likeCount: number;
  likedByMe: boolean;
};

type ContinueChatOption = {
  id: string;
  createdAt: number;
  title: string;
  lastMessage: string;
};


function safeString(v: any) {
  return typeof v === "string" ? v : "";
}

const FALLBACK_THUMB =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1b24"/>
      <stop offset="1" stop-color="#0b0b0f"/>
    </linearGradient>
  </defs>
  <rect width="800" height="450" fill="url(#g)"/>
  <text x="40" y="410" font-family="system-ui,-apple-system,Segoe UI,Roboto" font-size="20" fill="rgba(255,255,255,0.42)">No Cover</text>
</svg>`);

function pickThumb(p: Preset | null) {
  if (!p) return FALLBACK_THUMB;
  const img = safeString((p as any).image).trim();
  if (img) return img;
  const rawGallery = safeString((p as any).gallery).trim();
  if (rawGallery) {
    try {
      const parsed = JSON.parse(rawGallery);
      if (Array.isArray(parsed)) {
        const first = parsed[0];
        if (typeof first === "string" && first.trim()) return first.trim();
        if (first && typeof first === "object") {
          const u = safeString((first as any).url || (first as any).src || (first as any).image).trim();
          if (u) return u;
        }
      }
    } catch {
      // ignore
    }
  }
  return FALLBACK_THUMB;
}

function pickDesc(p: Preset | null) {
  if (!p) return "";
  const d = safeString((p as any).desc).trim();
  if (d) return d;
  const ch = safeString((p as any).character).trim();
  if (ch) return ch;
  const bg = safeString((p as any).background).trim();
  if (bg) return bg;
  const tags = safeString((p as any).tags).trim();
  if (tags) return tags;
  const target = safeString((p as any).target).trim();
  return target;
}

function formatDate(ts?: number) {
  if (!ts || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDateTime(ts?: number) {
  if (!ts || !Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function extractTags(preset: Preset | null): string[] {
  if (!preset) return [];
  const raw = [safeString((preset as any).tags), safeString((preset as any).target)].filter(Boolean).join(" ");

  const uniq: string[] = [];
  const seen = new Set<string>();

  const push = (t: string) => {
    const v = String(t || "").trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    uniq.push(v);
  };

  // 1) 해시태그 #태그
  const hashtags = Array.from(raw.matchAll(/#([\p{L}\p{N}_-]{1,32})/gu)).map((m) => `#${m[1]}`);
  hashtags.forEach((t) => push(t));

  // 2) 해시태그가 없으면: 콤마/공백 분리 태그도 지원(Workspace에서 엔터로 추가하는 경우 대비)
  if (uniq.length === 0) {
    const parts = raw
      .replace(/\r\n/g, "\n")
      .split(/[\n,]+/)
      .flatMap((s) => s.split(/\s+/))
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 24);

    for (const p of parts) {
      const cleaned = p.replace(/^#+/, "").slice(0, 32);
      if (!cleaned) continue;
      push(cleaned.startsWith("#") ? cleaned : `#${cleaned}`);
      if (uniq.length >= 12) break;
    }
  }

  return uniq.slice(0, 8);
}

export default function WorkSelectModal(props: {
  open: boolean;
  onClose: () => void;
  preset: Preset | null;
  latestChatLoaded: boolean;
  continueChats: ContinueChatOption[];
  onContinueChat: (chatId: string) => void;
  onDeleteContinueChat: (chatId: string) => void;
  onNew: () => void;
}) {
  const { open, onClose, preset, latestChatLoaded, continueChats, onContinueChat, onDeleteContinueChat, onNew } = props;

  // IMPORTANT: Hooks must be called unconditionally in the same order.
  // `useMemo` is a hook, so it must be above any early-return like `if (!open) return null;`.
  const tags = useMemo(() => extractTags(preset), [preset]);

  // 1차: 소개/댓글 탭 UI만 먼저 완성(댓글은 준비중)
  const [tab, setTab] = useState<"intro" | "comments">("intro");
  const [chatCount, setChatCount] = useState<number | null>(null);
  const [meta, setMeta] = useState<PresetMeta | null>(null);
  const [creator, setCreator] = useState<PresetCreator | null>(null);
  const [me, setMe] = useState<{ email: string; nickname?: string | null } | null>(null);
  const [comments, setComments] = useState<PresetComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [commentErr, setCommentErr] = useState<string | null>(null);
  const [commentSending, setCommentSending] = useState(false);
  const [continuePickerOpen, setContinuePickerOpen] = useState(false);


  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    setTab("intro");
  }, [open]);

  useEffect(() => {
    if (open) return;
    setContinuePickerOpen(false);
  }, [open]);

  useEffect(() => {
    if (continueChats.length > 0) return;
    setContinuePickerOpen(false);
  }, [continueChats.length]);

  useEffect(() => {
    if (!open) return;
    const pid = preset?.id;
    if (!pid) return;
    let cancelled = false;
    setChatCount(null);
    fetch(`/api/chat/count?presetId=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        const n = j && typeof j.count === "number" ? j.count : null;
        setChatCount(n);
      })
      .catch(() => {
        if (cancelled) return;
        setChatCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, preset?.id]);

  useEffect(() => {
    if (!open) return;
    // current user (for like/follow/comment UI)
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        const u = j?.user;
        setMe(u && u.email ? { email: String(u.email), nickname: u.nickname ?? null } : null);
      })
      .catch(() => {
        if (cancelled) return;
        setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const pid = preset?.id;
    if (!pid) return;
    let cancelled = false;

    // 1) increment view once per open/preset
    fetch("/api/preset/meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presetId: pid, action: "view" }),
    }).catch(() => {});

    // 2) fetch meta
    setMeta(null);
    setCreator(null);
    fetch(`/api/preset/meta?presetId=${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        const m = j?.meta;
        if (m && typeof m.views === "number") setMeta(m as PresetMeta);
        const c = j?.creator;
        if (c && ("email" in c || "nickname" in c || "name" in c)) setCreator(c as PresetCreator);
      })
      .catch(() => {
        if (cancelled) return;
        setMeta(null);
      });

    return () => {
      cancelled = true;
    };
  }, [open, preset?.id]);

  useEffect(() => {
    if (!open) return;
    if (tab !== "comments") return;
    const pid = preset?.id;
    if (!pid) return;
    let cancelled = false;
    setCommentsLoading(true);
    setCommentErr(null);
    fetch(`/api/preset/comments?presetId=${encodeURIComponent(pid)}&limit=50`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setComments(Array.isArray(j?.comments) ? (j.comments as PresetComment[]) : []);
      })
      .catch(() => {
        if (cancelled) return;
        setComments([]);
      })
      .finally(() => {
        if (cancelled) return;
        setCommentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, preset?.id, tab]);

  if (!open) return null;

  const title = preset?.name?.trim() || "(제목 없음)";
  const desc = pickDesc(preset) || "설명이 없습니다.";
  const thumb = pickThumb(preset);
  const thumbBg = `url("${thumb.replace(/"/g, '\\"')}")`;
  const createdAt = formatDate((preset as any)?.createdAt);

  // 작성자 표시 우선순위
  // 1) (본인인 경우) 세션의 최신 닉네임
  // 2) creator.nickname -> creator.name
  // 3) 이메일은 그대로 노출하지 않고 로컬파트( @ 앞 )만 사용
  const creatorEmail = (creator?.email ? String(creator.email).trim() : "") || ((preset as any)?.ownerEmail ? String((preset as any).ownerEmail).trim() : "") || ((preset as any)?.userEmail ? String((preset as any).userEmail).trim() : "");
  const meEmail = (me?.email || "").trim();
  const isMeCreator = !!creatorEmail && !!meEmail && creatorEmail.toLowerCase() === meEmail.toLowerCase();
  const creatorDisplay =
    (isMeCreator && me?.nickname ? String(me.nickname).trim() : "") ||
    (creator?.nickname && String(creator.nickname).trim()) ||
    (creator?.name && String(creator.name).trim()) ||
    (creatorEmail ? creatorEmail.split("@")[0] : "") ||
    "익명";

  const continueDisabled = !latestChatLoaded || continueChats.length === 0;
  const continueLabel = !latestChatLoaded ? "불러오는 중…" : continueChats.length > 0 ? "이어하기" : "이어하기 (기록 없음)";
  const continueTitle = (c: ContinueChatOption, index: number) => {
    const t = String(c?.title || "").trim();
    if (t) return t;
    const preview = String(c?.lastMessage || "")
      .replace(/^\s*\*+\s*/, "")
      .replace(/\s*\*+\s*$/, "")
      .trim();
    if (preview) return preview.length > 46 ? `${preview.slice(0, 46)}…` : preview;
    return `대화 ${index + 1}`;
  };
  const openContinuePicker = () => {
    if (continueDisabled) return;
    setContinuePickerOpen(true);
  };
  const onPickContinueChat = (chatId: string) => {
    setContinuePickerOpen(false);
    onContinueChat(chatId);
  };

  const toggleLike = async () => {
    const pid = preset?.id;
    if (!pid) return;
    setCommentErr(null);
    const r = await fetch("/api/preset/like", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presetId: pid }),
    });
    if (r.status === 401) {
      setCommentErr("로그인이 필요합니다.");
      return;
    }
    const j = await r.json().catch(() => null);
    if (j?.ok) {
      setMeta((prev) =>
        prev ? { ...prev, likeCount: Number(j.likeCount || 0), likedByMe: !!j.likedByMe } : prev
      );
    }
  };

  const toggleFollow = async () => {
    const pid = preset?.id;
    if (!pid) return;
    setCommentErr(null);
    const r = await fetch("/api/preset/follow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presetId: pid }),
    });
    if (r.status === 401) {
      setCommentErr("로그인이 필요합니다.");
      return;
    }
    const j = await r.json().catch(() => null);
    if (j?.ok) {
      setMeta((prev) =>
        prev ? { ...prev, followCount: Number(j.followCount || 0), followedByMe: !!j.followedByMe } : prev
      );
    }
  };

  return (
    <>
      <style jsx>{`
        /* Mobile 1차: 작품 상세 모달이 '너무 확대/길게' 느껴지는 부분을 먼저 개선 */
        .wsStage {
          padding: 16px;
          align-items: center;
          justify-content: center;
        }

        .wsModal {
          width: min(1120px, 100%);
          height: min(780px, calc(100vh - 32px));
          max-height: calc(100vh - 32px);
          border-radius: 20px;
        }

        @supports (height: 100dvh) {
          .wsModal {
            height: min(780px, calc(100dvh - 32px));
            max-height: calc(100dvh - 32px);
          }
        }

        .wsGrid {
          display: grid;
          grid-template-columns: minmax(280px, 0.46fr) minmax(0, 1fr);
          height: 100%;
        }

        .wsLeft {
          display: block;
          min-height: 0;
          overflow: hidden;
          border-right: 1px solid rgba(255,255,255,0.10);
        }

        .wsStatGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
        }

        .wsStatCard {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.12);
          background: linear-gradient(155deg, rgba(255,255,255,0.11) 0%, rgba(255,255,255,0.03) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.08),
            0 10px 26px rgba(0,0,0,0.24);
        }

        .wsStatIcon {
          width: 30px;
          height: 30px;
          border-radius: 999px;
          display: grid;
          place-items: center;
          box-shadow: 0 8px 16px rgba(0,0,0,0.25);
          flex: 0 0 auto;
        }

        .wsStatMeta {
          display: flex;
          flex-direction: column;
          min-width: 0;
          gap: 1px;
        }

        .wsStatLabel {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.2px;
          opacity: 0.68;
          line-height: 1.05;
        }

        .wsStatValue {
          font-size: 15px;
          font-weight: 950;
          letter-spacing: -0.2px;
          line-height: 1.15;
        }

        .wsFooter {
          padding: 14px;
          border-top: 1px solid rgba(255,255,255,0.10);
          background:
            linear-gradient(180deg, rgba(25,26,34,0.96) 0%, rgba(8,8,10,0.98) 100%);
        }

        .wsCtaGrid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }

        .wsCtaButton {
          min-height: 62px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.20);
          padding: 10px 14px;
          color: #e9eefc;
          cursor: pointer;
          font-weight: 900;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          justify-content: center;
          gap: 3px;
          text-align: left;
          transition: transform 120ms ease, box-shadow 140ms ease, filter 120ms ease;
        }

        .wsCtaButton:disabled {
          cursor: not-allowed;
          filter: grayscale(0.1);
        }

        .wsCtaButtonSecondary {
          background: linear-gradient(145deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.04) 100%);
        }

        .wsCtaButtonPrimary {
          border: 1px solid rgba(112,190,255,0.34);
          background: linear-gradient(145deg, rgba(118,185,255,0.34) 0%, rgba(76,135,255,0.18) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.20),
            0 14px 26px rgba(44,108,214,0.22);
        }

        .wsCtaButton:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 14px 26px rgba(0,0,0,0.30);
        }

        .wsCtaTitle {
          font-size: 15px;
          line-height: 1.15;
          font-weight: 950;
          letter-spacing: -0.2px;
        }

        .wsCtaHint {
          font-size: 11px;
          line-height: 1.2;
          opacity: 0.72;
          font-weight: 700;
          letter-spacing: 0.1px;
        }

        @media (max-width: 860px) {
          .wsStage {
            padding: 0px;
            align-items: stretch;
            justify-content: stretch;
          }

          .wsModal {
            width: 100%;
            height: 100vh;
            max-height: 100vh;
            border-radius: 0px;
          }

          @supports (height: 100dvh) {
            .wsModal {
              height: 100dvh;
              max-height: 100dvh;
            }
          }

          .wsGrid {
            grid-template-columns: 1fr;
            grid-template-rows: auto minmax(0, 1fr);
          }

          .wsLeft {
            display: block;
            border-right: none;
            border-bottom: 1px solid rgba(255, 255, 255, 0.10);
            min-height: 0;
            height: clamp(220px, 34vh, 360px);
          }

          .wsMainImg {
            max-height: 100% !important;
            object-fit: cover !important;
            border-radius: 0px !important;
          }

          .wsTitle {
            font-size: 18px !important;
          }

          .wsStatGrid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .wsCtaGrid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          zIndex: 80,
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="wsStage"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 90,
          display: "flex",
        }}
      >
        <div
          className="wsModal"
          style={{
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(10,10,12,0.96)",
            backdropFilter: "blur(10px)",
            boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
            overflow: "hidden",
          }}
        >
          <div
            className="wsGrid"
          >
            {/* 좌측: 이미지 크게 */}
            <div
              className="wsLeft"
              style={{
                position: "relative",
                background: "rgba(255,255,255,0.03)",
              }}
            >
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  backgroundImage: thumbBg,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  filter: "blur(22px)",
                  opacity: 0.28,
                  transform: "scale(1.05)",
                }}
              />
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  inset: 0,
                  background:
                    "linear-gradient(90deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.35) 55%, rgba(0,0,0,0.55) 100%)",
                }}
              />
              <div
                style={{
                  position: "relative",
                  height: "100%",
                  padding: 18,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className="wsMainImg"
                  src={thumb}
                  alt={title}
                  style={{
                    width: "100%",
                    height: "100%",
                    maxHeight: "calc(100% - 12px)",
                    objectFit: "cover",
                    borderRadius: 18,
                    boxShadow: "0 24px 70px rgba(0,0,0,0.46)",
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(255,255,255,0.04)",
                  }}
                />
              </div>
            </div>

            {/* 우측: 정보 패널 */}
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
              {/* 상단 탭 + 닫기 */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "14px 14px 10px 14px",
                  borderBottom: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => setTab("intro")}
                    style={{
                      fontWeight: 900,
                      fontSize: 13,
                      padding: "8px 10px",
                      borderRadius: 12,
                      border: tab === "intro" ? "1px solid rgba(255,255,255,0.22)" : "1px solid rgba(255,255,255,0.10)",
                      background: tab === "intro" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                      color: "#e9eefc",
                      cursor: "pointer",
                    }}
                  >
                    소개
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("comments")}
                    style={{
                      fontWeight: 900,
                      fontSize: 13,
                      padding: "8px 10px",
                      borderRadius: 12,
                      border: tab === "comments" ? "1px solid rgba(255,255,255,0.22)" : "1px solid rgba(255,255,255,0.10)",
                      background: tab === "comments" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                      color: "#e9eefc",
                      cursor: "pointer",
                    }}
                  >
                    댓글
                  </button>
                </div>

                {/* 우측: 닫기 */}
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={toggleLike}
                    disabled={!me}
                    title={me ? "좋아요" : "로그인 필요"}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      height: 38,
                      padding: "0 14px",
                      borderRadius: 999,
                      border: meta?.likedByMe ? "1px solid rgba(255,110,140,0.35)" : "1px solid rgba(255,255,255,0.14)",
                      background:
                        meta?.likedByMe
                          ? "linear-gradient(145deg, rgba(255,110,140,0.28) 0%, rgba(255,110,140,0.12) 100%)"
                          : "linear-gradient(145deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 100%)",
                      color: me ? "#e9eefc" : "rgba(233,238,252,0.55)",
                      cursor: me ? "pointer" : "not-allowed",
                      fontWeight: 900,
                      fontSize: 12,
                      boxShadow: meta?.likedByMe ? "0 10px 22px rgba(255,98,136,0.24)" : "0 8px 18px rgba(0,0,0,0.22)",
                    }}
                  >
                    <span aria-hidden>{meta?.likedByMe ? "❤️" : "🤍"}</span>
                    <span>{meta?.likeCount?.toLocaleString("ko-KR") ?? "0"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="닫기"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,0.14)",
                      background: "rgba(255,255,255,0.06)",
                      color: "#e9eefc",
                      cursor: "pointer",
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* 본문(스크롤) */}
              <div
                style={{
                  padding: 14,
                  paddingBottom: "calc(14px + env(safe-area-inset-bottom, 0px))",
                  overflow: "auto",
                  flex: "1 1 auto",
                  WebkitOverflowScrolling: "touch" as any,
                  overscrollBehavior: "contain" as any,
                }}
              >
                {tab === "intro" ? (
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      {/* 타이틀 + 작성자 */}
                      <div>
                        <div className="wsTitle" style={{ fontWeight: 950, fontSize: 22, lineHeight: 1.2, letterSpacing: -0.2 }}>{title}</div>
                        <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                            <div
                              aria-hidden
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: 14,
                                background: "rgba(255,255,255,0.10)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flex: "0 0 auto",
                                overflow: "hidden",
                                boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
                              }}
                            >
                              {creator?.image ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={creator.image}
                                  alt=""
                                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                                />
                              ) : (
                                "👤"
                              )}
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 11, opacity: 0.65, fontWeight: 900 }}>작성자</div>
                              <div
                                style={{
                                  marginTop: 2,
                                  fontWeight: 950,
                                  fontSize: 13,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {creatorDisplay}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <button
                              type="button"
                              onClick={toggleFollow}
                              disabled={!me}
                              title={me ? "팔로우" : "로그인 필요"}
                              style={{
                                height: 36,
                                borderRadius: 999,
                                padding: "0 14px",
                                border: meta?.followedByMe ? "1px solid rgba(120,180,255,0.30)" : "1px solid rgba(255,255,255,0.14)",
                                background: meta?.followedByMe ? "rgba(120,180,255,0.16)" : "rgba(255,255,255,0.06)",
                                color: me ? "#e9eefc" : "rgba(233,238,252,0.55)",
                                cursor: me ? "pointer" : "not-allowed",
                                fontWeight: 950,
                                fontSize: 12,
                              }}
                            >
                              {meta?.followedByMe ? "팔로잉" : "팔로우"}
                            </button>
                            <button
                              type="button"
                              onClick={toggleLike}
                              disabled={!me}
                              aria-label={meta?.likedByMe ? "하트 선택됨" : "하트 선택"}
                              title={me ? "하트 선택" : "로그인 필요"}
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: 999,
                                border: meta?.likedByMe ? "1px solid rgba(255,110,140,0.35)" : "1px solid rgba(255,255,255,0.14)",
                                background: meta?.likedByMe ? "rgba(255,110,140,0.16)" : "rgba(255,255,255,0.06)",
                                color: me ? "#e9eefc" : "rgba(233,238,252,0.55)",
                                cursor: me ? "pointer" : "not-allowed",
                                fontSize: 16,
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              <span aria-hidden>{meta?.likedByMe ? "❤️" : "🤍"}</span>
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* 통계 */}
                      <div className="wsStatGrid">
                        <div
                          title="대화 수"
                          className="wsStatCard"
                          style={{ borderColor: "rgba(108,178,255,0.24)" }}
                        >
                          <span aria-hidden className="wsStatIcon" style={{ background: "rgba(95,168,255,0.22)" }}>
                            💬
                          </span>
                          <span className="wsStatMeta">
                            <span className="wsStatLabel">대화 수</span>
                            <span className="wsStatValue">{chatCount === null ? "—" : chatCount.toLocaleString("ko-KR")}</span>
                          </span>
                        </div>

                        <div
                          title="하트 수"
                          className="wsStatCard"
                          style={{ borderColor: "rgba(255,116,147,0.28)" }}
                        >
                          <span aria-hidden className="wsStatIcon" style={{ background: "rgba(255,106,142,0.24)" }}>
                            ❤️
                          </span>
                          <span className="wsStatMeta">
                            <span className="wsStatLabel">하트 수</span>
                            <span className="wsStatValue">{meta?.likeCount?.toLocaleString("ko-KR") ?? "0"}</span>
                          </span>
                        </div>

                        <div
                          title="팔로우 수"
                          className="wsStatCard"
                          style={{ borderColor: "rgba(130,216,172,0.26)" }}
                        >
                          <span aria-hidden className="wsStatIcon" style={{ background: "rgba(110,202,156,0.24)" }}>
                            👥
                          </span>
                          <span className="wsStatMeta">
                            <span className="wsStatLabel">팔로우 수</span>
                            <span className="wsStatValue">{meta?.followCount?.toLocaleString("ko-KR") ?? "0"}</span>
                          </span>
                        </div>
                      </div>

{/* 태그 */}
                      {tags.length > 0 && (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {tags.map((t) => (
                            <span
                              key={t}
                              style={{
                                fontSize: 12,
                                padding: "6px 10px",
                                borderRadius: 999,
                                border: "1px solid rgba(255,120,120,0.28)",
                                background: "rgba(255,120,120,0.08)",
                                color: "#e9eefc",
                                opacity: 0.95,
                                fontWeight: 900,
                              }}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* 설명 */}
                      <div
                        style={{
                          borderRadius: 16,
                          border: "1px solid rgba(255,255,255,0.10)",
                          background: "rgba(255,255,255,0.03)",
                          padding: 12,
                        }}
                      >
                        <div style={{ fontWeight: 950, fontSize: 13, opacity: 0.9 }}>설명</div>
                        <div
                          style={{
                            marginTop: 8,
                            fontSize: 13,
                            opacity: 0.84,
                            lineHeight: 1.6,
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {desc}
                        </div>
                        {createdAt && <div style={{ marginTop: 10, fontSize: 12, opacity: 0.68 }}>제작일: {createdAt}</div>}
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {/* 에러 */}
                    {commentErr && (
                      <div
                        style={{
                          padding: "10px 12px",
                          borderRadius: 12,
                          border: "1px solid rgba(255,120,120,0.25)",
                          background: "rgba(255,120,120,0.08)",
                          fontSize: 12,
                          opacity: 0.95,
                        }}
                      >
                        {commentErr}
                      </div>
                    )}

                    {/* 작성 */}
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 14,
                        border: "1px solid rgba(255,255,255,0.10)",
                        background: "rgba(255,255,255,0.03)",
                      }}
                    >
                      <div style={{ fontWeight: 900, fontSize: 13, opacity: 0.92 }}>댓글</div>
                      <textarea
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        placeholder={me ? "댓글을 입력하세요…" : "로그인 후 댓글을 작성할 수 있어요."}
                        disabled={!me || commentSending}
                        maxLength={500}
                        style={{
                          marginTop: 8,
                          width: "100%",
                          minHeight: 80,
                          resize: "vertical",
                          padding: 10,
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.12)",
                          background: "rgba(0,0,0,0.25)",
                          color: "#e9eefc",
                          outline: "none",
                          fontSize: 13,
                          lineHeight: 1.6,
                        }}
                      />
                      <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {commentText.length.toLocaleString("ko-KR")}/500
                        </div>
                        <button
                          type="button"
                          disabled={!me || commentSending || commentText.trim().length === 0}
                          onClick={async () => {
                            const pid = preset?.id;
                            if (!pid) return;
                            const text = commentText.trim();
                            if (!text) return;
                            setCommentSending(true);
                            setCommentErr(null);
                            try {
                              const r = await fetch("/api/preset/comments", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ presetId: pid, content: text }),
                              });
                              if (r.status === 401) {
                                setCommentErr("로그인이 필요합니다.");
                                return;
                              }
                              const j = await r.json().catch(() => null);
                              if (!j?.ok) {
                                setCommentErr(j?.error || "댓글 작성 실패");
                                return;
                              }
                              const c = j.comment as PresetComment;
                              setCommentText("");
                              setComments((prev) => [c, ...prev]);
                            } finally {
                              setCommentSending(false);
                            }
                          }}
                          style={{
                            borderRadius: 12,
                            padding: "10px 14px",
                            border: "1px solid rgba(255,255,255,0.18)",
                            background:
                              !me || commentText.trim().length === 0 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.10)",
                            color: !me || commentText.trim().length === 0 ? "rgba(233,238,252,0.55)" : "#e9eefc",
                            cursor: !me || commentText.trim().length === 0 ? "not-allowed" : "pointer",
                            fontWeight: 900,
                            fontSize: 13,
                          }}
                          title={me ? "댓글 등록" : "로그인 필요"}
                        >
                          {commentSending ? "등록 중…" : "등록"}
                        </button>
                      </div>
                    </div>

                    {/* 목록 */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                        <div style={{ fontWeight: 900, fontSize: 13, opacity: 0.92 }}>
                          댓글 목록{" "}
                          <span style={{ fontWeight: 800, opacity: 0.7 }}>
                            ({comments.length.toLocaleString("ko-KR")})
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            const pid = preset?.id;
                            if (!pid) return;
                            setCommentsLoading(true);
                            setCommentErr(null);
                            try {
                              const r = await fetch(`/api/preset/comments?presetId=${encodeURIComponent(pid)}&limit=50`);
                              const j = await r.json().catch(() => null);
                              setComments(Array.isArray(j?.comments) ? (j.comments as PresetComment[]) : []);
                            } catch {
                              setComments([]);
                            } finally {
                              setCommentsLoading(false);
                            }
                          }}
                          style={{
                            borderRadius: 10,
                            padding: "8px 10px",
                            border: "1px solid rgba(255,255,255,0.12)",
                            background: "rgba(255,255,255,0.04)",
                            color: "#e9eefc",
                            cursor: "pointer",
                            fontWeight: 900,
                            fontSize: 12,
                            opacity: 0.9,
                          }}
                        >
                          새로고침
                        </button>
                      </div>

                      {commentsLoading ? (
                        <div style={{ padding: 12, fontSize: 13, opacity: 0.75 }}>불러오는 중…</div>
                      ) : comments.length === 0 ? (
                        <div style={{ padding: 12, fontSize: 13, opacity: 0.75 }}>아직 댓글이 없습니다.</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {comments.map((c) => (
                            <div
                              key={c.id}
                              style={{
                                padding: 12,
                                borderRadius: 14,
                                border: "1px solid rgba(255,255,255,0.10)",
                                background: "rgba(255,255,255,0.02)",
                              }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                                    <div
                                      style={{
                                        width: 28,
                                        height: 28,
                                        borderRadius: 999,
                                        overflow: "hidden",
                                        background: "rgba(255,255,255,0.06)",
                                        border: "1px solid rgba(255,255,255,0.10)",
                                        flex: "0 0 auto",
                                      }}
                                    >
                                      {c.userImage ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                          src={c.userImage}
                                          alt=""
                                          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                                        />
                                      ) : (
                                        <span style={{ display: "block", width: "100%", textAlign: "center", lineHeight: "28px", fontSize: 12, fontWeight: 900 }}>
                                          @
                                        </span>
                                      )}
                                    </div>

                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                                        <div
                                          style={{
                                            fontWeight: 950,
                                            fontSize: 13,
                                            color: "#e9eefc",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                            maxWidth: 220,
                                          }}
                                          title={c.userNickname || c.userEmail}
                                        >
                                          {c.userNickname || c.userEmail}
                                        </div>
                                        <div style={{ fontSize: 12, opacity: 0.6, whiteSpace: "nowrap" }}>
                                          {new Date(c.createdAt).toLocaleString("ko-KR")}
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                  <div style={{ marginTop: 6, fontSize: 13, opacity: 0.86, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                                    {c.content}
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  disabled={!me}
                                  onClick={async () => {
                                    if (!me) {
                                      setCommentErr("로그인이 필요합니다.");
                                      return;
                                    }
                                    const r = await fetch("/api/preset/comments/like", {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ commentId: c.id }),
                                    });
                                    if (r.status === 401) {
                                      setCommentErr("로그인이 필요합니다.");
                                      return;
                                    }
                                    const j = await r.json().catch(() => null);
                                    if (j?.ok) {
                                      setComments((prev) =>
                                        prev.map((x) =>
                                          x.id === c.id
                                            ? { ...x, likeCount: Number(j.likeCount || 0), likedByMe: !!j.likedByMe }
                                            : x
                                        )
                                      );
                                    }
                                  }}
                                  style={{
                                    flex: "0 0 auto",
                                    borderRadius: 999,
                                    padding: "8px 10px",
                                    border: "1px solid rgba(255,255,255,0.12)",
                                    background: me ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.02)",
                                    color: me ? "#e9eefc" : "rgba(233,238,252,0.55)",
                                    cursor: me ? "pointer" : "not-allowed",
                                    fontWeight: 900,
                                    fontSize: 12,
                                    height: 34,
                                    alignSelf: "flex-start",
                                  }}
                                  title={me ? "댓글 좋아요" : "로그인 필요"}
                                >
                                  {c.likedByMe ? "❤️" : "🤍"} {c.likeCount.toLocaleString("ko-KR")}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
)}
              </div>

              {/* 하단 CTA 고정 */}
              <div
                className="wsFooter"
              >
                <div className="wsCtaGrid">
                  <button
                    type="button"
                    onClick={openContinuePicker}
                    disabled={continueDisabled}
                    className={`wsCtaButton wsCtaButtonSecondary`}
                    style={
                      continueDisabled
                        ? { background: "rgba(255,255,255,0.04)", color: "rgba(233,238,252,0.55)" }
                        : undefined
                    }
                  >
                    <span className="wsCtaTitle">{continueLabel}</span>
                  </button>

                  <button
                    type="button"
                    onClick={onNew}
                    className="wsCtaButton wsCtaButtonPrimary"
                  >
                    <span className="wsCtaTitle">처음하기</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {continuePickerOpen && (
        <div
          onClick={() => setContinuePickerOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 96,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 14,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(520px, calc(100vw - 28px))",
              maxHeight: "min(560px, calc(100vh - 40px))",
              overflow: "auto",
              borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "linear-gradient(180deg, rgba(20,20,24,0.98), rgba(10,10,12,0.96))",
              boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
              padding: 14,
              color: "#e9eefc",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
              <div style={{ fontSize: 15, fontWeight: 950 }}>이어하기 선택</div>
              <button
                type="button"
                onClick={() => setContinuePickerOpen(false)}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e9eefc",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
                title="닫기"
              >
                ✕
              </button>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
              {continueChats.slice(0, 3).map((c, index) => (
                <div
                  key={c.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) auto",
                    gap: 8,
                    alignItems: "stretch",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onPickContinueChat(c.id)}
                    style={{
                      minWidth: 0,
                      border: "1px solid rgba(255,255,255,0.16)",
                      borderRadius: 12,
                      background: "rgba(255,255,255,0.06)",
                      color: "#e9eefc",
                      padding: "10px 12px",
                      textAlign: "left",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 900,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={continueTitle(c, index)}
                    >
                      {continueTitle(c, index)}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.72 }}>{formatDateTime(c.createdAt)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteContinueChat(c.id)}
                    title="채팅 삭제"
                    style={{
                      width: 38,
                      border: "1px solid rgba(255,120,120,0.36)",
                      borderRadius: 12,
                      background: "rgba(255,120,120,0.10)",
                      color: "#ffd7d7",
                      cursor: "pointer",
                      fontSize: 14,
                      fontWeight: 900,
                    }}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
