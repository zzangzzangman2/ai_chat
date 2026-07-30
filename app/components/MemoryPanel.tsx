"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  chatId: string;
  embed?: boolean;
  turnKey?: number;
};

type SummaryRes = {
  ok: boolean;
  chatId: string;
  summary: string;
  meta?: {
    summarizedEndTurn?: number;
    rolledUpCount?: number;
    lastSummarizedAt?: number;
    updatedAt?: number;
    recentSummaryChars?: number;
  };
  policy?: {
    mode?: string;
    summaryEvery?: number;
    perTurnChars?: number;
    keepUserTurns?: number;
  };
  error?: string;
};

type CharacterRosterItem = {
  id: string;
  name: string;
  aliases: string;
  role: string;
  profile: string;
  relationshipNote: string;
  emotionNote: string;
  status: string;
  enabled: boolean;
  memoryCount?: number;
  updatedAt?: number;
  memories?: CharacterMemory[];
};

type CharacterMemory = { turnNo: number; summary: string; evidence?: string; updatedAt?: number };

type CharacterMemoryView = {
  memories: CharacterMemory[];
  offset: number;
  total: number;
  hasMore: boolean;
  selectedTurnNo?: number;
  loading?: boolean;
  loaded?: boolean;
  open?: boolean;
  error?: string;
};

const emptyCharacterDraft: CharacterRosterItem = {
  id: "",
  name: "",
  aliases: "",
  role: "",
  profile: "",
  relationshipNote: "",
  emotionNote: "",
  status: "",
  enabled: true,
};

// Per-turn chars selector for long memory (요약.txt).
// NOTE: 일부 채팅은 160을 사용했으므로 호환값으로 유지한다.
const PER_TURN_OPTIONS = [80, 140, 160, 200, 260, 320] as const;

type PerTurnChars = (typeof PER_TURN_OPTIONS)[number];

function normalizePerTurnChars(v: any): PerTurnChars {
  const n = Number(v);
  if (PER_TURN_OPTIONS.includes(n as PerTurnChars)) return n as PerTurnChars;
  // closest match
  let best: PerTurnChars = PER_TURN_OPTIONS[0];
  for (const opt of PER_TURN_OPTIONS) {
    if (Math.abs(opt - n) < Math.abs(best - n)) best = opt;
  }
  return best;
}

export default function MemoryPanel({ theme: THEME, chatId, embed, turnKey }: Props) {
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<{
    done: number;
    total: number;
    step: number;
    lastRange?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<string>("");
  const [meta, setMeta] = useState<SummaryRes["meta"]>({});
  const [policy, setPolicy] = useState<SummaryRes["policy"]>({});
  const [err, setErr] = useState<string>("");
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterSaving, setRosterSaving] = useState(false);
  const [characters, setCharacters] = useState<CharacterRosterItem[]>([]);
  const [characterDraft, setCharacterDraft] = useState<CharacterRosterItem>(emptyCharacterDraft);
  const [characterMemoryViews, setCharacterMemoryViews] = useState<Record<string, CharacterMemoryView>>({});

  // summary edit
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const lastLoadedSummaryRef = useRef<string>("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const refreshLockRef = useRef(false);

  // per-turn chars selector (3턴 고정, 총 글자수는 perTurnChars*3)
  const [perTurnChars, setPerTurnChars] = useState<PerTurnChars>(80);

  const basePer = normalizePerTurnChars(policy?.perTurnChars ?? 80);
  const baseEvery = Math.max(1, Number(policy?.summaryEvery ?? 3));
  const effectivePer = perTurnChars;
  const totalChars = effectivePer * 3; // summaryEvery는 3으로 고정 정책이지만 UI에서 총량을 직관적으로 보여주기 위해 3턴 기준으로 표시
  const policyDirty = effectivePer !== basePer;

  const metaLine = useMemo(() => {
    const end = meta?.summarizedEndTurn || 0;
    const chars = meta?.recentSummaryChars || 0;
    const rolled = meta?.rolledUpCount || 0;
    const last = meta?.updatedAt || meta?.lastSummarizedAt || 0;
    const when = last ? new Date(last).toLocaleString() : "";
    const every = policy?.summaryEvery ?? 3;
    const per = policy?.perTurnChars ?? 80;
    const mode = policy?.mode ?? "B";
    return `mode ${mode} · ${per}자/턴 · ${every}턴/블록 · endTurn ${end} · ${chars} chars · rollup ${rolled}${when ? ` · ${when}` : ""}`;
  }, [meta, policy]);

  const load = useCallback(async () => {
    if (!chatId) return;
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(`/api/chat/memory/summary?chatId=${encodeURIComponent(chatId)}`, { cache: "no-store" });
      const json = (await res.json()) as SummaryRes;
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const nextSummary = String(json.summary || "");
      setSummary(nextSummary);
      lastLoadedSummaryRef.current = nextSummary;
      setMeta(json.meta || {});
      setPolicy(json.policy || {});
      setPerTurnChars(normalizePerTurnChars(json.policy?.perTurnChars ?? 80));
      setDirty(false);
      setEditing(false);
    } catch (e: any) {
      setErr(e?.message || "요약을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  const doRefresh = useCallback(async () => {
    if (!chatId) return;

    // When already refreshing, treat a click as "cancel".
    if (refreshing) {
      refreshAbortRef.current?.abort();
      return;
    }
    if (refreshLockRef.current) return;

    if (dirty) {
      const ok = window.confirm(
        "저장되지 않은 변경이 있어요. 저장하지 않고 갱신하면 내용이 덮어써질 수 있습니다. 계속할까요?"
      );
      if (!ok) return;
      setDirty(false);
      setEditing(false);
      setSummary(lastLoadedSummaryRef.current);
    }
    refreshLockRef.current = true;

    setRefreshing(true);
    setErr("");
    setRefreshProgress(null);

    const ac = new AbortController();
    refreshAbortRef.current = ac;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let steps = 0;
    let lastEnd = -1;
    let lastBoundary = 0;
    let memoryErr = "";

    try {
      // Auto catch-up:
      // keep calling /refresh until it reports up-to-date or we cannot make further progress.
      while (true) {
        steps += 1;
        if (steps > 500) {
          throw new Error(
            "장기기억 갱신 반복 한도(500회)를 초과했습니다. 턴이 매우 많거나, 저장이 반복적으로 스킵되는 상황일 수 있어요."
          );
        }

        const res = await fetch("/api/chat/memory/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId, perTurnChars: effectivePer, allowBadOutputSave: false }),
          signal: ac.signal,
        });

        if (!res.ok) {
          const t = await res.text().catch(() => "");
          throw new Error(t || `HTTP ${res.status}`);
        }

        const json = (await res.json().catch(() => null)) as any;

        const boundaryEndTurn = Number(json?.boundaryEndTurn ?? lastBoundary ?? 0);
        const summarizedEndTurn = Number(json?.summarizedEndTurn ?? json?.windowEndTurn ?? 0);

        if (Number.isFinite(boundaryEndTurn) && boundaryEndTurn > 0) lastBoundary = boundaryEndTurn;

        const lastRange =
          json?.windowStartTurn && json?.windowEndTurn ? `${json.windowStartTurn}-${json.windowEndTurn}` : undefined;

        if (Number.isFinite(summarizedEndTurn) && summarizedEndTurn >= 0) {
          setRefreshProgress({
            done: summarizedEndTurn,
            total: boundaryEndTurn || lastBoundary || 0,
            step: steps,
            lastRange,
          });
        }

        // Stop conditions
        if (json?.skipped) {
          const r = String(json?.reason || "skipped");

          if (r === "uptodate" || r === "no_complete_block") {
            break;
          }

          if (r === "partial_window_not_allowed") {
            // Not enough completed turns to build a full (3턴) block yet.
            break;
          }

          if (r === "bad_output") {
            const qReason = String(json?.quality?.reason || "").trim();
            const nReason = String(json?.nameDrift?.reason || "").trim();
            const reasons = [qReason ? `quality:${qReason}` : "", nReason ? `name:${nReason}` : ""]
              .filter(Boolean)
              .join(" / ");
            memoryErr = reasons
              ? `요약 출력이 규칙을 위반해 저장하지 않았습니다. (${reasons}) 다시 갱신해 주세요.`
              : "요약 출력이 규칙을 위반(영문/깨짐 등)하여 저장하지 않았습니다. 다시 갱신을 시도해 주세요.";
            break;
          }

          if (r === "stale_source_changed") {
            // If messages were edited/deleted while summarizing, retry a couple times.
            if (steps <= 3) {
              await sleep(250);
              continue;
            }
            memoryErr = "요약 생성 중 대화가 수정/삭제되어 저장을 건너뛰었습니다. (레이스) 다시 한 번 갱신을 눌러주세요.";
            break;
          }

          // Other skip reasons may still allow forward progress (e.g. range already exists).
        }

        const boundary = boundaryEndTurn || lastBoundary || 0;
        if (boundary > 0 && summarizedEndTurn >= boundary) break;

        // No progress guard (avoid infinite loops)
        if (summarizedEndTurn === lastEnd) break;
        lastEnd = summarizedEndTurn;

        // Yield to UI / avoid hammering
        await sleep(80);
      }

      await load();
      if (memoryErr) setErr(memoryErr);
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setErr("갱신을 중지했습니다.");
      } else {
        const hardErr = e?.message || "refresh 실패";
        await load();
        setErr(`요약: ${hardErr}`);
      }
    } finally {
      refreshAbortRef.current = null;
      setRefreshing(false);
      setRefreshProgress(null);
      refreshLockRef.current = false;
    }
  }, [chatId, dirty, effectivePer, load, refreshing]);

  const doSave = useCallback(async () => {
    if (!chatId) return;
    setSaving(true);
    setErr("");
    try {
      const payload: any = { chatId, perTurnChars: effectivePer };
      if (dirty) payload.summary = summary;

      const res = await fetch("/api/chat/memory/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      setErr(e?.message || "저장 실패");
    } finally {
      setSaving(false);
    }
  }, [chatId, dirty, effectivePer, load, summary]);

  const doEdit = useCallback(() => {
    setEditing(true);
    // focus on next tick
    setTimeout(() => taRef.current?.focus(), 0);
  }, []);

  const doCancelEdit = useCallback(() => {
    setSummary(lastLoadedSummaryRef.current);
    setDirty(false);
    setEditing(false);
  }, []);

  const loadCharacters = useCallback(async () => {
    if (!chatId) return;
    setRosterLoading(true);
    try {
      const res = await fetch(`/api/chat/characters?chatId=${encodeURIComponent(chatId)}&includeMemories=0`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      const list = Array.isArray(json.characters) ? (json.characters as CharacterRosterItem[]) : [];
      setCharacters(list);
      setCharacterMemoryViews((prev) => {
        const next: Record<string, CharacterMemoryView> = {};
        for (const c of list) {
          const total = Math.max(0, Number(c.memoryCount || 0));
          const old = prev[c.id];
          const countChanged = !!old && old.total !== total;
          const memories = !countChanged && Array.isArray(old?.memories) ? old.memories : [];
          const offset = !countChanged ? Math.min(Number(old?.offset || memories.length), total) : 0;
          next[c.id] = {
            memories,
            offset,
            total,
            hasMore: offset < total,
            selectedTurnNo: countChanged ? undefined : old?.selectedTurnNo,
            loading: false,
            loaded: !countChanged && !!old?.loaded,
            open: old?.open || false,
          };
        }
        return next;
      });
    } catch (e: any) {
      setErr(e?.message || "캐릭터 등록부를 불러오지 못했습니다.");
    } finally {
      setRosterLoading(false);
    }
  }, [chatId]);

  const loadCharacterMemories = useCallback(
    async (rosterId: string, reset = false) => {
      if (!chatId || !rosterId) return;
      const current = characterMemoryViews[rosterId];
      const offset = reset ? 0 : Math.max(0, Number(current?.offset || 0));
      setCharacterMemoryViews((prev) => ({
        ...prev,
        [rosterId]: {
          memories: reset ? [] : prev[rosterId]?.memories || [],
          offset,
          total: Number(prev[rosterId]?.total || 0),
          hasMore: true,
          selectedTurnNo: reset ? undefined : prev[rosterId]?.selectedTurnNo,
          open: true,
          loaded: prev[rosterId]?.loaded && !reset,
          loading: true,
        },
      }));

      try {
        const res = await fetch(
          `/api/chat/characters?chatId=${encodeURIComponent(chatId)}&rosterId=${encodeURIComponent(
            rosterId
          )}&offset=${offset}&limit=5`,
          { cache: "no-store" }
        );
        const json = (await res.json().catch(() => null)) as any;
        if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        const rows = Array.isArray(json.memories) ? (json.memories as CharacterMemory[]) : [];
        setCharacterMemoryViews((prev) => {
          const old = prev[rosterId] || {
            memories: [],
            offset: 0,
            total: 0,
            hasMore: false,
          };
          const merged = reset
            ? rows
            : [
                ...old.memories,
                ...rows.filter((m) => !old.memories.some((oldMemory) => oldMemory.turnNo === m.turnNo)),
              ];
          const selectedTurnNo = old.selectedTurnNo;
          return {
            ...prev,
            [rosterId]: {
              memories: merged,
              offset: Number(json.nextOffset ?? offset + rows.length),
              total: Number(json.total ?? merged.length),
              hasMore: Boolean(json.hasMore),
              selectedTurnNo,
              loading: false,
              loaded: true,
              open: true,
            },
          };
        });
      } catch (e: any) {
        setCharacterMemoryViews((prev) => ({
          ...prev,
          [rosterId]: {
            memories: prev[rosterId]?.memories || [],
            offset: prev[rosterId]?.offset || 0,
            total: prev[rosterId]?.total || 0,
            hasMore: prev[rosterId]?.hasMore || false,
            selectedTurnNo: prev[rosterId]?.selectedTurnNo,
            loading: false,
            loaded: prev[rosterId]?.loaded || false,
            open: true,
            error: e?.message || "기록을 불러오지 못했습니다.",
          },
        }));
      }
    },
    [characterMemoryViews, chatId]
  );

  const toggleCharacterMemories = useCallback(
    (c: CharacterRosterItem) => {
      const state = characterMemoryViews[c.id];
      if (state?.open) {
        setCharacterMemoryViews((prev) => ({
          ...prev,
          [c.id]: { ...prev[c.id], open: false },
        }));
        return;
      }
      setCharacterMemoryViews((prev) => ({
        ...prev,
        [c.id]: {
          memories: prev[c.id]?.memories || [],
          offset: prev[c.id]?.offset || 0,
          total: Number(prev[c.id]?.total ?? c.memoryCount ?? 0),
          hasMore: prev[c.id]?.hasMore ?? Number(c.memoryCount || 0) > 0,
          selectedTurnNo: prev[c.id]?.selectedTurnNo,
          loading: prev[c.id]?.loading || false,
          loaded: prev[c.id]?.loaded || false,
          open: true,
        },
      }));
      if (Number(c.memoryCount || state?.total || 0) > 0 && !state?.loaded && !state?.loading) {
        void loadCharacterMemories(c.id, true);
      }
    },
    [characterMemoryViews, loadCharacterMemories]
  );

  const selectCharacterTurn = useCallback((rosterId: string, turnNo: number) => {
    setCharacterMemoryViews((prev) => ({
      ...prev,
      [rosterId]: {
        ...(prev[rosterId] || { memories: [], offset: 0, total: 0, hasMore: false }),
        selectedTurnNo: turnNo,
        open: true,
      },
    }));
  }, []);

  const saveCharacter = useCallback(async () => {
    if (!chatId) return;
    const name = characterDraft.name.trim();
    if (!name) {
      setErr("캐릭터 이름을 입력해 주세요.");
      return;
    }
    setRosterSaving(true);
    setErr("");
    try {
      const method = characterDraft.id ? "PATCH" : "POST";
      const res = await fetch("/api/chat/characters", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: characterDraft.id,
          chatId,
          name,
          aliases: "",
          role: "",
          profile: "",
          relationshipNote: "",
          emotionNote: "",
          status: "",
          enabled: true,
        }),
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setCharacterDraft(emptyCharacterDraft);
      await loadCharacters();
    } catch (e: any) {
      setErr(e?.message || "캐릭터 저장에 실패했습니다.");
    } finally {
      setRosterSaving(false);
    }
  }, [characterDraft, chatId, loadCharacters]);

  const deleteCharacter = useCallback(
    async (id: string) => {
      if (!id) return;
      if (!window.confirm("이 캐릭터를 등록부에서 삭제할까요?")) return;
      setRosterSaving(true);
      setErr("");
      try {
        const res = await fetch(`/api/chat/characters?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        const json = (await res.json().catch(() => null)) as any;
        if (!res.ok || !json?.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        if (characterDraft.id === id) setCharacterDraft(emptyCharacterDraft);
        await loadCharacters();
      } catch (e: any) {
        setErr(e?.message || "캐릭터 삭제에 실패했습니다.");
      } finally {
        setRosterSaving(false);
      }
    },
    [characterDraft.id, loadCharacters]
  );

  useEffect(() => {
    load();
    loadCharacters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  useEffect(() => {
    // 새 턴이 들어올 때마다 메타/요약을 다시 확인
    if (turnKey == null) return;
    load();
  }, [turnKey, load]);

  useEffect(() => {
    if (!chatId) return;
    const onMemoryRefreshed = (ev: Event) => {
      if (dirty || editing || refreshing || saving) return;
      const detail = (ev as CustomEvent<{ chatId?: string }>).detail;
      const refreshedChatId = String(detail?.chatId || "");
      if (!refreshedChatId || refreshedChatId !== chatId) return;
      load();
      loadCharacters();
    };
    window.addEventListener("mate:memory-refreshed", onMemoryRefreshed as EventListener);
    return () => {
      window.removeEventListener("mate:memory-refreshed", onMemoryRefreshed as EventListener);
    };
  }, [chatId, dirty, editing, refreshing, saving, load, loadCharacters]);

  const wrapStyle = {
    border: `1px solid ${THEME.border}`,
    background: THEME.panel2,
    borderRadius: 16,
    padding: embed ? "12px 12px 18px" : 14,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
  } as const;

  const canSave = !saving && !loading && !refreshing && (dirty || policyDirty);

  return (
    <div style={wrapStyle}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 900 }}>요약.txt</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>{metaLine}</div>

          {/* 최상단: 턴당 글자수 선택 */}
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.85, fontWeight: 800 }}>턴당 길이</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {PER_TURN_OPTIONS.map((opt) => {
                const active = effectivePer === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setPerTurnChars(opt)}
                    style={{
                      height: 26,
                      padding: "0 10px",
                      borderRadius: 999,
                      border: active ? "none" : `1px solid ${THEME.borderSoft}`,
                      background: active ? "#4f46e5" : THEME.panel,
                      color: active ? "#fff" : THEME.text,
                      fontWeight: 900,
                      cursor: "pointer",
                      opacity: 1,
                    }}
                    title={`${opt}자/턴 (3턴 고정: 총 ${opt * 3}자)`}
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>3턴 고정 · 총 {totalChars}자</div>
            {baseEvery !== 3 ? <div style={{ fontSize: 12, opacity: 0.5 }}>(현재 정책 every={baseEvery})</div> : null}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={doRefresh}
            disabled={loading || saving}
            style={{
              height: 34,
              padding: "0 12px",
              borderRadius: 12,
              border: "none",
              background: "#4f46e5",
              color: "#fff",
              fontWeight: 900,
              cursor: "pointer",
              opacity: loading || saving ? 0.6 : 1,
            }}
            title={refreshing ? "갱신 중지" : "요약 블록 생성/갱신 (누락된 구간을 끝까지 자동 생성)"}
          >
            {refreshing ? (refreshProgress?.total ? `중지 · ${refreshProgress.done}/${refreshProgress.total}턴` : "중지") : "갱신"}
          </button>

          <button
            type="button"
            onClick={editing ? doCancelEdit : doEdit}
            disabled={loading || refreshing}
            style={{
              height: 34,
              padding: "0 12px",
              borderRadius: 12,
              border: `1px solid ${THEME.borderSoft}`,
              background: THEME.panel,
              color: THEME.text,
              fontWeight: 900,
              cursor: "pointer",
              opacity: loading || refreshing ? 0.6 : 1,
            }}
            title={editing ? "편집 취소" : "내용 수정"}
          >
            {editing ? "취소" : "수정"}
          </button>

          <button
            type="button"
            onClick={doSave}
            disabled={!canSave}
            style={{
              height: 34,
              padding: "0 12px",
              borderRadius: 12,
              border: `1px solid ${THEME.borderSoft}`,
              background: THEME.panel,
              color: THEME.text,
              fontWeight: 800,
              cursor: "pointer",
              opacity: canSave ? 1 : 0.6,
            }}
            title={dirty || policyDirty ? "서버에 저장" : "변경사항 없음"}
          >
            {saving ? "저장…" : "저장"}
          </button>
        </div>
      </div>

      {err ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 12,
            border: `1px solid ${THEME.borderSoft}`,
            background: "rgba(239,68,68,0.10)",
            color: "#fecaca",
            fontSize: 13,
          }}
        >
          {err}
        </div>
      ) : null}

      {refreshing && refreshProgress ? (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
          자동 갱신 중… endTurn {refreshProgress.done}/{refreshProgress.total || "?"}
          {refreshProgress.lastRange ? ` · 블록 ${refreshProgress.lastRange}` : ""}
        </div>
      ) : null}

      <textarea
        ref={taRef}
        value={summary}
        readOnly={!editing}
        onChange={(e) => {
          if (!editing) return;
          setSummary(e.target.value);
          setDirty(true);
        }}
        placeholder={loading ? "로딩 중…" : "아직 요약이 없습니다."}
        rows={embed ? 9 : 20}
        style={{
          width: "100%",
          marginTop: 12,
          padding: 12,
          boxSizing: "border-box",
          minHeight: embed ? 150 : undefined,
          maxHeight: embed ? "32dvh" : undefined,
          borderRadius: 12,
          border: `1px solid ${THEME.borderSoft}`,
          background: THEME.panel,
          color: THEME.text,
          outline: "none",
          resize: "vertical",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          lineHeight: 1.55,
          whiteSpace: "pre-wrap",
          opacity: editing ? 1 : 0.85,
        }}
      />

      <div
        style={{
          marginTop: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          fontSize: 12,
          opacity: 0.75,
        }}
      >
        <div>{summary.length} chars</div>
        <div style={{ opacity: 0.6 }}>
          {embed
            ? ""
            : dirty
              ? "※ 저장 버튼을 눌러야 반영됩니다."
              : policyDirty
                ? "※ 길이 설정이 저장되지 않았습니다."
                : "※ 이 텍스트가 장기기억(요약)으로 프롬프트에 들어갑니다."}
        </div>
      </div>

      <div style={{ marginTop: 14, borderTop: `1px solid ${THEME.borderSoft}`, paddingTop: 12, paddingBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ fontWeight: 900 }}>캐릭터 기억</div>
            <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4 }}>이름만 등록하면 만난 턴을 자동으로 쌓습니다.</div>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gap: 8,
            marginTop: 12,
          }}
        >
          <input
            value={characterDraft.name}
            onChange={(e) => setCharacterDraft((p) => ({ ...p, name: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                saveCharacter();
              }
            }}
            placeholder="기억할 인물 이름"
            style={{
              minWidth: 0,
              height: 38,
              padding: "0 12px",
              borderRadius: 12,
              border: `1px solid ${THEME.borderSoft}`,
              background: THEME.panel,
              color: THEME.text,
              outline: "none",
              fontWeight: 800,
            }}
          />
          <button
            type="button"
            onClick={saveCharacter}
            disabled={rosterSaving}
            style={{
              height: 38,
              padding: "0 16px",
              borderRadius: 12,
              border: "none",
              background: "#4f46e5",
              color: "#fff",
              fontWeight: 900,
              cursor: "pointer",
              opacity: rosterSaving ? 0.65 : 1,
            }}
          >
            {rosterSaving ? "저장 중" : "추가"}
          </button>
        </div>

        <div style={{ display: "grid", gap: 8, marginTop: 10, paddingBottom: 8 }}>
          {rosterLoading ? (
            <div style={{ fontSize: 13, opacity: 0.7 }}>등록부를 불러오는 중...</div>
          ) : characters.length ? (
            characters.map((c) => {
              const state = characterMemoryViews[c.id] || {
                memories: [],
                offset: 0,
                total: Number(c.memoryCount || 0),
                hasMore: Number(c.memoryCount || 0) > 0,
              };
              const memories = state.memories || [];
              const selectedMemory = memories.find((m) => m.turnNo === state.selectedTurnNo) || null;
              const isOpen = Boolean(state.open);
              const total = Math.max(Number(c.memoryCount || 0), Number(state.total || 0));
              return (
                <div
                  key={c.id}
                  style={{
                    position: "relative",
                    border: `1px solid ${isOpen ? "rgba(129,140,248,0.78)" : THEME.borderSoft}`,
                    background: isOpen
                      ? `linear-gradient(135deg, rgba(79,70,229,0.16), ${THEME.panel} 42%)`
                      : THEME.panel,
                    borderRadius: 14,
                    padding: "11px 11px 12px",
                    minWidth: 0,
                    boxShadow: isOpen ? "0 0 0 1px rgba(129,140,248,0.20), 0 14px 34px rgba(0,0,0,0.22)" : "none",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 12,
                      bottom: 12,
                      width: 3,
                      borderRadius: 999,
                      background: isOpen ? "#818cf8" : "rgba(255,255,255,0.14)",
                    }}
                  />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                    <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 950, fontSize: 15 }}>{c.name}</div>
                      <div
                        style={{
                          fontSize: 11,
                          padding: "3px 8px",
                          borderRadius: 999,
                          border: `1px solid ${isOpen ? "rgba(129,140,248,0.55)" : THEME.borderSoft}`,
                          background: isOpen ? "rgba(129,140,248,0.14)" : "transparent",
                          color: isOpen ? "#c7d2fe" : THEME.muted,
                          fontWeight: 800,
                        }}
                      >
                        {total ? `${total}턴 기록` : "대기 중"}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={() => toggleCharacterMemories(c)}
                        disabled={state.loading || total <= 0}
                        style={{
                          height: 30,
                          padding: "0 10px",
                          borderRadius: 10,
                          border: `1px solid ${isOpen ? "rgba(129,140,248,0.60)" : THEME.borderSoft}`,
                          background: isOpen ? "rgba(129,140,248,0.20)" : THEME.panel2,
                          color: total <= 0 ? THEME.muted : THEME.text,
                          cursor: total <= 0 || state.loading ? "default" : "pointer",
                          fontWeight: 900,
                          opacity: total <= 0 ? 0.65 : 1,
                        }}
                      >
                        {state.loading ? "불러오는 중" : isOpen ? "접기" : "기록 보기"}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteCharacter(c.id)}
                        style={{
                          height: 30,
                          padding: "0 9px",
                          borderRadius: 10,
                          border: `1px solid ${THEME.borderSoft}`,
                          background: "rgba(239,68,68,0.12)",
                          color: "#fecaca",
                          cursor: "pointer",
                        }}
                      >
                        삭제
                      </button>
                    </div>
                  </div>

                  {!total ? (
                    <div style={{ marginTop: 8, fontSize: 12, opacity: 0.6 }}>아직 실제로 만난 턴이 없습니다.</div>
                  ) : null}

                  {isOpen ? (
                    <div style={{ marginTop: 10, display: "grid", gap: 9 }}>
                      {state.error ? <div style={{ fontSize: 12, color: "#fecaca" }}>{state.error}</div> : null}

                      {memories.length ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {memories.map((m) => {
                            const active = state.selectedTurnNo === m.turnNo;
                            return (
                              <button
                                key={`${c.id}-${m.turnNo}`}
                                type="button"
                                onClick={() => selectCharacterTurn(c.id, m.turnNo)}
                                style={{
                                  height: 28,
                                  padding: "0 10px",
                                  borderRadius: 999,
                                  border: active ? "1px solid rgba(199,210,254,0.95)" : `1px solid ${THEME.borderSoft}`,
                                  background: active ? "#4f46e5" : "rgba(255,255,255,0.04)",
                                  color: active ? "#fff" : THEME.text,
                                  cursor: "pointer",
                                  fontWeight: 900,
                                  fontSize: 12,
                                }}
                              >
                                {m.turnNo}턴
                              </button>
                            );
                          })}
                          {state.hasMore ? (
                            <button
                              type="button"
                              onClick={() => loadCharacterMemories(c.id)}
                              disabled={state.loading}
                              style={{
                                height: 28,
                                padding: "0 10px",
                                borderRadius: 999,
                                border: `1px solid ${THEME.borderSoft}`,
                                background: THEME.panel2,
                                color: THEME.text,
                                cursor: state.loading ? "default" : "pointer",
                                fontWeight: 900,
                                fontSize: 12,
                                opacity: state.loading ? 0.65 : 1,
                              }}
                            >
                              더보기
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {state.loading ? "턴 기록을 불러오는 중..." : "아직 불러온 턴이 없습니다."}
                          </div>
                          {!state.loading && total > 0 ? (
                            <button
                              type="button"
                              onClick={() => loadCharacterMemories(c.id, true)}
                              style={{
                                height: 28,
                                padding: "0 10px",
                                borderRadius: 999,
                                border: `1px solid ${THEME.borderSoft}`,
                                background: THEME.panel2,
                                color: THEME.text,
                                cursor: "pointer",
                                fontWeight: 900,
                                fontSize: 12,
                              }}
                            >
                              기록 불러오기
                            </button>
                          ) : null}
                        </div>
                      )}

                      {selectedMemory ? (
                        <div
                          style={{
                            border: "1px solid rgba(129,140,248,0.38)",
                            background: "rgba(0,0,0,0.16)",
                            borderRadius: 12,
                            padding: "10px 11px",
                            fontSize: 12,
                            lineHeight: 1.55,
                            minWidth: 0,
                          }}
                        >
                          <div style={{ fontWeight: 950, color: "#c7d2fe", marginBottom: 5 }}>{selectedMemory.turnNo}턴</div>
                          <div style={{ overflowWrap: "anywhere", wordBreak: "keep-all" }}>{selectedMemory.summary}</div>
                        </div>
                      ) : memories.length ? (
                        <div style={{ fontSize: 12, opacity: 0.6 }}>턴 버튼을 누르면 요약이 열립니다.</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div
              style={{
                border: `1px dashed ${THEME.borderSoft}`,
                borderRadius: 12,
                padding: 14,
                fontSize: 13,
                opacity: 0.72,
                textAlign: "center",
              }}
            >
              아직 등록된 인물이 없습니다.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
