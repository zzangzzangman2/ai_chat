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

type Relation = {
  id: string;
  subjectKey: string;
  subjectName: string;
  subjectRosterId: string;
  relation: string;
  slotKey: string;
  objectKey: string;
  objectName: string;
  objectRosterId: string;
  objectRole: string;
  firstSeenTurn: number;
  lastSeenTurn: number;
};

type Affinity = {
  id: string;
  rosterId: string;
  personaName: string;
  characterName: string;
  score: number;
  label: string;
  relationshipLabel: string;
  lastDelta: number;
  reason: string;
  evidence: string;
  lastTurnNo: number;
};

type GraphNode = {
  id: string;
  key: string;
  name: string;
  rosterId: string;
  age: number;
  ageSource: string;
  role: string;
  relationshipNote: string;
  profile: string;
  isPersona: boolean;
  isUnknown: boolean;
  updatedAt: number;
};

type CharacterMemory = {
  turnNo: number;
  summary: string;
  evidence?: string;
  updatedAt?: number;
};

type CharacterDetails = {
  id: string;
  name: string;
  role: string;
  profile: string;
  relationshipNote: string;
  emotionNote: string;
  status: string;
  memoryCount: number;
};

type GraphResponse = {
  ok: boolean;
  personaName: string;
  nodes: GraphNode[];
  relations: Relation[];
  affinities: Affinity[];
  error?: string;
};

type SelectedPerson = {
  name: string;
  rosterId: string;
};

type MemoryState = {
  character: CharacterDetails | null;
  memories: CharacterMemory[];
  total: number;
  offset: number;
  hasMore: boolean;
  loading: boolean;
  error: string;
};

const emptyMemoryState: MemoryState = {
  character: null,
  memories: [],
  total: 0,
  offset: 0,
  hasMore: false,
  loading: false,
  error: "",
};

function clampScore(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 50;
}

function affinityColor(scoreRaw: number) {
  const score = clampScore(scoreRaw);
  if (score >= 70) return "#fb7185";
  if (score >= 58) return "#f472b6";
  if (score >= 43) return "#a78bfa";
  if (score >= 28) return "#60a5fa";
  return "#94a3b8";
}

function shortLabel(value: string, fallback: string) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[。.!?].*$/u, "")
    .trim();
  if (!normalized) return fallback;
  return normalized.length > 13 ? `${normalized.slice(0, 12)}…` : normalized;
}

function CenteredRelationshipGraph({
  nodes,
  relations,
  affinities,
  selected,
  theme,
  onSelect,
}: {
  nodes: GraphNode[];
  relations: Relation[];
  affinities: Affinity[];
  selected: SelectedPerson | null;
  theme: Theme;
  onSelect: (person: SelectedPerson) => void;
}) {
  const graph = useMemo(() => {
    const persona =
      nodes.find((node) => node.isPersona || node.key === "persona") ||
      ({
        id: "persona",
        key: "persona",
        name: "페르소나",
        rosterId: "",
        age: 0,
        ageSource: "",
        role: "페르소나",
        relationshipNote: "",
        profile: "",
        isPersona: true,
        isUnknown: false,
        updatedAt: 0,
      } satisfies GraphNode);
    const outer = nodes
      .filter((node) => node.key !== persona.key)
      .slice(0, 28);
    const rowsPerSide = Math.max(1, Math.ceil(outer.length / 2));
    const rowGap = 96;
    const height = Math.max(620, rowsPerSide * rowGap + 150);
    const center = { x: 500, y: height / 2 };
    const positions = new Map<string, { x: number; y: number }>();
    positions.set(persona.key, center);
    outer.forEach((node, index) => {
      const rightSide = index % 2 === 1;
      const row = Math.floor(index / 2);
      const sideRows = rightSide ? Math.floor(outer.length / 2) : Math.ceil(outer.length / 2);
      const top = (height - Math.max(0, sideRows - 1) * rowGap) / 2;
      positions.set(node.key, {
        x: rightSide ? 820 : 180,
        y: top + row * rowGap,
      });
    });

    const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
    nodeByKey.set(persona.key, persona);
    const affinityByRoster = new Map(
      affinities.map((affinity) => [affinity.rosterId, affinity])
    );
    const actual = relations
      .filter(
        (relation) =>
          positions.has(relation.subjectKey) &&
          positions.has(relation.objectKey)
      )
      .map((relation) => ({
        id: relation.id,
        from: relation.subjectKey,
        to: relation.objectKey,
        label: relation.relation,
        actual: true,
      }));
    const directlyConnected = new Set<string>();
    for (const edge of actual) {
      if (edge.from === persona.key) directlyConnected.add(edge.to);
      if (edge.to === persona.key) directlyConnected.add(edge.from);
    }
    const virtual = outer
      .filter((node) => node.rosterId && !directlyConnected.has(node.key))
      .map((node) => {
        const affinity = affinityByRoster.get(node.rosterId);
        return {
          id: `persona-link-${node.key}`,
          from: persona.key,
          to: node.key,
          label: shortLabel(affinity?.relationshipLabel || "", "관계 미정"),
          actual: false,
        };
      });
    return {
      persona,
      outer,
      positions,
      nodeByKey,
      affinityByRoster,
      edges: [...virtual, ...actual],
      center,
      height,
    };
  }, [affinities, nodes, relations]);

  const linePoints = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    fromRadius: number,
    toRadius: number
  ) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    return {
      x1: from.x + (dx / length) * fromRadius,
      y1: from.y + (dy / length) * fromRadius,
      x2: to.x - (dx / length) * toRadius,
      y2: to.y - (dy / length) * toRadius,
    };
  };

  return (
    <div
      style={{
        border: `1px solid ${theme.borderSoft}`,
        borderRadius: 22,
        overflowX: "auto",
        overflowY: "hidden",
        background:
          "radial-gradient(circle at 50% 48%, rgba(99,102,241,0.18), transparent 24%), radial-gradient(circle at 18% 10%, rgba(34,211,238,0.09), transparent 24%), rgba(255,255,255,0.018)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 20px 45px rgba(0,0,0,0.16)",
      }}
    >
      <svg
        viewBox={`0 0 1000 ${graph.height}`}
        aria-label="페르소나 중심 인물관계도"
        style={{ display: "block", width: "100%", minWidth: 880, height: "auto" }}
      >
        <defs>
          <marker
            id="relationship-arrow-actual"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f472b6" />
          </marker>
          <marker
            id="relationship-arrow-soft"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#818cf8" />
          </marker>
          <filter id="relationship-node-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {graph.edges.map((edge) => {
          const from = graph.positions.get(edge.from);
          const to = graph.positions.get(edge.to);
          if (!from || !to) return null;
          const points = linePoints(
            from,
            to,
            edge.from === "persona" ? 104 : 88,
            edge.to === "persona" ? 104 : 88
          );
          const labelRatio = edge.actual
            ? 0.5
            : edge.from === "persona" ? 0.68 : edge.to === "persona" ? 0.32 : 0.5;
          const midX = points.x1 + (points.x2 - points.x1) * labelRatio;
          const midY = points.y1 + (points.y2 - points.y1) * labelRatio;
          const labelWidth = Math.max(48, Math.min(150, edge.label.length * 12 + 24));
          return (
            <g key={edge.id}>
              <line
                {...points}
                stroke={edge.actual ? "#f472b6" : "#818cf8"}
                strokeWidth={edge.actual ? 2.4 : 1.7}
                strokeDasharray={edge.actual ? undefined : "7 7"}
                opacity={edge.actual ? 0.88 : 0.5}
                markerEnd={`url(#${edge.actual ? "relationship-arrow-actual" : "relationship-arrow-soft"})`}
              />
              <g transform={`translate(${midX}, ${midY})`}>
                <rect
                  x={-labelWidth / 2}
                  y={-13}
                  width={labelWidth}
                  height={26}
                  rx={13}
                  fill={edge.actual ? "rgba(131,24,67,0.92)" : "rgba(49,46,129,0.90)"}
                  stroke={edge.actual ? "rgba(244,114,182,0.72)" : "rgba(129,140,248,0.58)"}
                />
                <text
                  x="0"
                  y="4"
                  textAnchor="middle"
                  fill={edge.actual ? "#fce7f3" : "#e0e7ff"}
                  fontSize="12"
                  fontWeight="800"
                >
                  {edge.label}
                </text>
              </g>
            </g>
          );
        })}

        {[graph.persona, ...graph.outer].map((node) => {
          const point = graph.positions.get(node.key);
          if (!point) return null;
          const persona = node.key === "persona";
          const affinity = node.rosterId
            ? graph.affinityByRoster.get(node.rosterId)
            : undefined;
          const nodeWidth = persona ? 188 : 158;
          const nodeHeight = persona ? 54 : 46;
          const color = persona
            ? "#67e8f9"
            : node.isUnknown
              ? "#94a3b8"
              : affinityColor(affinity?.score ?? 50);
          const clickable = Boolean(node.rosterId);
          const active = clickable && selected?.rosterId === node.rosterId;
          return (
            <g
              key={node.key}
              transform={`translate(${point.x}, ${point.y})`}
              onClick={() => {
                if (clickable) onSelect({ name: node.name, rosterId: node.rosterId });
              }}
              onKeyDown={(event) => {
                if (clickable && (event.key === "Enter" || event.key === " ")) {
                  onSelect({ name: node.name, rosterId: node.rosterId });
                }
              }}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `${node.name}의 개별 장기기억 보기` : node.name}
              style={{ cursor: clickable ? "pointer" : "default", outline: "none" }}
            >
              {active ? (
                <rect
                  x={-nodeWidth / 2 - 5}
                  y={-nodeHeight / 2 - 5}
                  width={nodeWidth + 10}
                  height={nodeHeight + 10}
                  rx={16}
                  fill="rgba(244,114,182,0.08)"
                  stroke="#f9a8d4"
                  strokeWidth="2"
                />
              ) : null}
              <rect
                x={-nodeWidth / 2}
                y={-nodeHeight / 2}
                width={nodeWidth}
                height={nodeHeight}
                rx={persona ? 14 : 11}
                fill={
                  persona
                    ? "rgba(8,91,115,0.94)"
                    : node.isUnknown
                      ? "rgba(51,65,85,0.80)"
                      : "rgba(15,23,42,0.95)"
                }
                stroke={color}
                strokeWidth={persona ? 2.5 : 1.8}
                strokeDasharray={node.isUnknown ? "6 4" : undefined}
                filter={persona ? "url(#relationship-node-glow)" : undefined}
              />
              <text
                x="0"
                y="5"
                textAnchor="middle"
                fill="#fff"
                fontSize={persona ? "18" : "15"}
                fontWeight="950"
              >
                {node.isUnknown ? "이름 미상" : node.name}
              </text>
              <text
                x="0"
                y={nodeHeight / 2 + 19}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize="11"
                fontWeight="700"
              >
                {node.age ? `${node.age}세` : "나이 미상"}
                {affinity ? ` · ♥ ${clampScore(affinity.score)}` : ""}
              </text>
              {persona ? (
                <text x="0" y={-nodeHeight / 2 - 15} textAnchor="middle" fill="#67e8f9" fontSize="12" fontWeight="900">
                  페르소나 중심
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function PersonNode({
  name,
  sub,
  rosterId,
  persona,
  unknown,
  selected,
  theme,
  onSelect,
}: {
  name: string;
  sub?: string;
  rosterId?: string;
  persona?: boolean;
  unknown?: boolean;
  selected?: boolean;
  theme: Theme;
  onSelect: (person: SelectedPerson) => void;
}) {
  const clickable = Boolean(rosterId);
  return (
    <button
      type="button"
      className="relationship-graph-node"
      onClick={() => {
        if (clickable) onSelect({ name, rosterId: String(rosterId) });
      }}
      title={clickable ? `${name}의 개별 장기기억 보기` : unknown ? "이름이 밝혀지면 같은 노드에 연결됩니다." : ""}
      style={{
        width: "100%",
        minHeight: 82,
        padding: "12px 14px",
        borderRadius: 18,
        border: selected
          ? "1px solid rgba(244,114,182,0.95)"
          : persona
            ? "1px solid rgba(129,140,248,0.72)"
            : unknown
              ? `1px dashed ${theme.borderSoft}`
              : `1px solid ${theme.borderSoft}`,
        background: selected
          ? "linear-gradient(145deg, rgba(236,72,153,0.22), rgba(79,70,229,0.15))"
          : persona
            ? "linear-gradient(145deg, rgba(79,70,229,0.24), rgba(129,140,248,0.10))"
            : unknown
              ? "rgba(148,163,184,0.07)"
              : theme.panel2,
        color: theme.text,
        cursor: clickable ? "pointer" : "default",
        textAlign: "left",
        boxShadow: selected
          ? "0 0 0 2px rgba(244,114,182,0.12), 0 14px 30px rgba(0,0,0,0.20)"
          : persona
            ? "0 12px 28px rgba(79,70,229,0.13)"
            : "none",
        transition: "transform 150ms ease, border-color 150ms ease, box-shadow 150ms ease",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: "block",
              fontSize: 15,
              fontWeight: 950,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          <span style={{ display: "block", marginTop: 3, fontSize: 11, color: theme.muted }}>
            {sub || (clickable ? "눌러서 개별 기억 보기" : "역할 인물")}
          </span>
        </span>
      </div>
    </button>
  );
}

export default function RelationshipGraphPanel({
  theme,
  chatId,
  turnKey,
}: {
  theme: Theme;
  chatId: string;
  turnKey?: string | number;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [personaName, setPersonaName] = useState("");
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [affinities, setAffinities] = useState<Affinity[]>([]);
  const [selected, setSelected] = useState<SelectedPerson | null>(null);
  const memoryPanelRef = useRef<HTMLDivElement | null>(null);
  const [memoryState, setMemoryState] = useState<MemoryState>(emptyMemoryState);

  const loadGraph = useCallback(async () => {
    if (!chatId) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/chat/relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId }),
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as GraphResponse | null;
      if (!response.ok || !body?.ok) throw new Error(body?.error || "관계도를 불러오지 못했습니다.");
      setPersonaName(String(body.personaName || ""));
      setNodes(Array.isArray(body.nodes) ? body.nodes : []);
      setRelations(Array.isArray(body.relations) ? body.relations : []);
      setAffinities(Array.isArray(body.affinities) ? body.affinities : []);
    } catch (cause: any) {
      setError(String(cause?.message || "관계도를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [chatId]);

  const loadMemories = useCallback(
    async (person: SelectedPerson, offset = 0) => {
      if (!chatId || !person.rosterId) return;
      setMemoryState((previous) => ({
        ...(offset > 0 ? previous : emptyMemoryState),
        loading: true,
        error: "",
      }));
      try {
        const response = await fetch(
          `/api/chat/characters?chatId=${encodeURIComponent(chatId)}&rosterId=${encodeURIComponent(
            person.rosterId
          )}&limit=20&offset=${offset}`,
          { cache: "no-store" }
        );
        const body = (await response.json().catch(() => null)) as any;
        if (!response.ok || !body?.ok) throw new Error(body?.error || "개별 기억을 불러오지 못했습니다.");
        const incoming = Array.isArray(body.memories) ? body.memories : [];
        setMemoryState((previous) => ({
          character: body?.character || previous.character || null,
          memories: offset > 0 ? [...previous.memories, ...incoming] : incoming,
          total: Math.max(0, Number(body.total || 0)),
          offset: Math.max(0, Number(body.nextOffset || offset + incoming.length)),
          hasMore: Boolean(body.hasMore),
          loading: false,
          error: "",
        }));
      } catch (cause: any) {
        setMemoryState((previous) => ({
          ...previous,
          loading: false,
          error: String(cause?.message || "개별 기억을 불러오지 못했습니다."),
        }));
      }
    },
    [chatId]
  );

  const selectPerson = useCallback(
    (person: SelectedPerson) => {
      setSelected(person);
      setMemoryState(emptyMemoryState);
      void loadMemories(person, 0);
      window.setTimeout(() => {
        memoryPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 0);
    },
    [loadMemories]
  );

  useEffect(() => {
    setSelected(null);
    setMemoryState(emptyMemoryState);
    void loadGraph();
  }, [chatId, loadGraph]);

  useEffect(() => {
    if (!chatId || turnKey === undefined || turnKey === null) return;
    void loadGraph();
  }, [chatId, turnKey, loadGraph]);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent)?.detail || {};
      if (String(detail?.chatId || "") !== String(chatId || "")) return;
      void loadGraph();
    };
    window.addEventListener("mate:memory-refreshed", onRefresh as EventListener);
    return () => window.removeEventListener("mate:memory-refreshed", onRefresh as EventListener);
  }, [chatId, loadGraph]);

  const selectedAffinity = useMemo(
    () =>
      selected
        ? affinities.find(
            (affinity) =>
              affinity.rosterId === selected.rosterId ||
              affinity.characterName === selected.name
          ) || null
        : null,
    [affinities, selected]
  );

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <style>{`
        .relationship-graph-node:hover { transform: translateY(-2px); }
        .relationship-graph-arrow {
          display: grid;
          grid-template-columns: minmax(42px, 1fr) auto minmax(42px, 1fr);
          align-items: center;
          gap: 6px;
          min-width: 120px;
        }
        .relationship-graph-line { height: 2px; background: linear-gradient(90deg, rgba(129,140,248,.28), rgba(244,114,182,.9)); }
        .relationship-graph-tip {
          width: 0; height: 0;
          border-top: 6px solid transparent;
          border-bottom: 6px solid transparent;
          border-left: 9px solid #f472b6;
        }
        .relationship-graph-row {
          display: grid;
          grid-template-columns: minmax(150px, 1fr) minmax(150px, .8fr) minmax(150px, 1fr);
          align-items: center;
          gap: 12px;
        }
        @media (max-width: 680px) {
          .relationship-graph-row { grid-template-columns: 1fr; gap: 8px; }
          .relationship-graph-arrow { transform: rotate(90deg); width: 150px; justify-self: center; margin: 8px 0; }
          .relationship-graph-arrow-label { transform: rotate(-90deg); }
        }
      `}</style>

      <div
        style={{
          border: `1px solid ${theme.borderSoft}`,
          background: `radial-gradient(circle at 10% 0%, rgba(99,102,241,0.18), transparent 34%), ${theme.panel}`,
          borderRadius: 20,
          padding: 16,
          boxShadow: "0 18px 45px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ fontSize: 21 }}>🕸️</span>
              <span style={{ fontSize: 18, fontWeight: 950 }}>자동 관계도</span>
            </div>
            <div style={{ marginTop: 6, color: theme.muted, fontSize: 12, lineHeight: 1.5 }}>
              이름 미상 역할도 먼저 저장하고, 실명이 밝혀지면 같은 노드에 자동 연결합니다.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadGraph()}
            disabled={loading}
            style={{
              height: 34,
              padding: "0 12px",
              borderRadius: 12,
              border: `1px solid ${theme.borderSoft}`,
              background: theme.panel2,
              color: theme.text,
              cursor: loading ? "default" : "pointer",
              fontWeight: 900,
              opacity: loading ? 0.65 : 1,
            }}
          >
            {loading ? "동기화 중" : "새로고침"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 13 }}>
          {[
            `주인공 ${personaName || "미설정"}`,
            `인물 ${nodes.length}`,
            `관계 ${relations.length}`,
            `호감도 ${affinities.length}`,
            "자동 저장",
          ].map((label) => (
            <span
              key={label}
              style={{
                padding: "5px 9px",
                borderRadius: 999,
                background: "rgba(129,140,248,0.12)",
                border: "1px solid rgba(129,140,248,0.22)",
                color: "#c7d2fe",
                fontSize: 11,
                fontWeight: 900,
              }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      {error ? (
        <div style={{ padding: 12, borderRadius: 14, background: "rgba(239,68,68,0.10)", color: "#fecaca", fontSize: 13 }}>
          {error}
        </div>
      ) : null}

      <CenteredRelationshipGraph
        nodes={nodes}
        relations={relations}
        affinities={affinities}
        selected={selected}
        theme={theme}
        onSelect={selectPerson}
      />

      <div style={{ fontSize: 13, fontWeight: 950, color: theme.muted }}>
        관계 상세
      </div>

      <div style={{ display: "grid", gap: 11 }}>
        {relations.length ? (
          relations.map((relation) => {
            const objectName = relation.objectName || "이름 미상";
            return (
              <div
                key={relation.id}
                className="relationship-graph-row"
                style={{
                  border: `1px solid ${theme.borderSoft}`,
                  borderRadius: 20,
                  padding: 13,
                  background: "rgba(255,255,255,0.025)",
                }}
              >
                <PersonNode
                  name={relation.subjectName}
                  sub={relation.subjectKey === "persona" ? "주인공" : "관계의 기준 인물"}
                  rosterId={relation.subjectRosterId}
                  persona={relation.subjectKey === "persona"}
                  selected={selected?.rosterId === relation.subjectRosterId && Boolean(relation.subjectRosterId)}
                  theme={theme}
                  onSelect={selectPerson}
                />
                <div className="relationship-graph-arrow">
                  <span className="relationship-graph-line" />
                  <span
                    className="relationship-graph-arrow-label"
                    style={{
                      padding: "6px 10px",
                      borderRadius: 999,
                      background: "linear-gradient(135deg, rgba(99,102,241,.28), rgba(236,72,153,.25))",
                      border: "1px solid rgba(244,114,182,.42)",
                      color: "#fbcfe8",
                      fontSize: 12,
                      fontWeight: 950,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {relation.relation}
                  </span>
                  <span style={{ display: "flex", alignItems: "center" }}>
                    <span className="relationship-graph-line" style={{ flex: 1 }} />
                    <span className="relationship-graph-tip" />
                  </span>
                </div>
                <PersonNode
                  name={objectName}
                  sub={relation.objectName ? relation.objectRole : `${relation.objectRole} · 실명 대기`}
                  rosterId={relation.objectRosterId}
                  unknown={!relation.objectName}
                  selected={selected?.rosterId === relation.objectRosterId && Boolean(relation.objectRosterId)}
                  theme={theme}
                  onSelect={selectPerson}
                />
              </div>
            );
          })
        ) : !loading ? (
          <div
            style={{
              border: `1px dashed ${theme.borderSoft}`,
              borderRadius: 18,
              padding: 28,
              textAlign: "center",
              color: theme.muted,
              fontSize: 13,
            }}
          >
            아직 확정된 관계가 없습니다. 대화에서 “누구의 아버지/딸”처럼 관계가 나오면 자동으로 추가됩니다.
          </div>
        ) : null}
      </div>

      <div
        style={{
          border: `1px solid ${theme.borderSoft}`,
          borderRadius: 20,
          padding: 15,
          background: theme.panel,
        }}
      >
        <div style={{ fontWeight: 950, fontSize: 16 }}>호감도</div>
        <div style={{ marginTop: 4, color: theme.muted, fontSize: 12 }}>
          등록 인물이 주인공에게 느끼는 감정 변화만 직접 대화 턴마다 ±3 범위로 누적합니다.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 12 }}>
          {affinities.length ? (
            affinities.map((affinity) => {
              const score = clampScore(affinity.score);
              const color = affinityColor(score);
              const active = selected?.rosterId === affinity.rosterId;
              return (
                <button
                  key={affinity.id}
                  type="button"
                  onClick={() => selectPerson({ name: affinity.characterName, rosterId: affinity.rosterId })}
                  style={{
                    padding: 13,
                    borderRadius: 16,
                    border: active ? `1px solid ${color}` : `1px solid ${theme.borderSoft}`,
                    background: active ? `${color}18` : theme.panel2,
                    color: theme.text,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 950 }}>{affinity.characterName}</span>
                    <span style={{ color, fontWeight: 950 }}>
                      ♥ {score}
                      {affinity.lastDelta > 0 ? ` ↑+${affinity.lastDelta}` : affinity.lastDelta < 0 ? ` ↓${affinity.lastDelta}` : " →"}
                    </span>
                  </div>
                  <div style={{ height: 7, borderRadius: 999, background: "rgba(148,163,184,0.16)", marginTop: 10, overflow: "hidden" }}>
                    <div
                      style={{
                        width: `${score}%`,
                        height: "100%",
                        borderRadius: 999,
                        background: `linear-gradient(90deg, #6366f1, ${color})`,
                        transition: "width 260ms ease",
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8, fontSize: 11, color: theme.muted }}>
                    <span>{affinity.relationshipLabel}</span>
                    <span>{affinity.lastTurnNo ? `${affinity.label} · ${affinity.lastTurnNo}턴` : "초기값"}</span>
                  </div>
                  {affinity.reason ? (
                    <div style={{ marginTop: 7, fontSize: 11, lineHeight: 1.45, color: theme.muted }}>
                      {affinity.reason}
                    </div>
                  ) : null}
                </button>
              );
            })
          ) : (
            <div style={{ color: theme.muted, fontSize: 13 }}>직접 대화한 등록 인물이 생기면 호감도가 표시됩니다.</div>
          )}
        </div>
      </div>

      {selected ? (
        <div
          ref={memoryPanelRef}
          style={{
            border: "1px solid rgba(244,114,182,0.34)",
            borderRadius: 20,
            padding: 16,
            background: "linear-gradient(145deg, rgba(79,70,229,0.12), rgba(236,72,153,0.08))",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 950 }}>{selected.name}</div>
              <div style={{ marginTop: 4, color: theme.muted, fontSize: 12 }}>
                개별 장기기억 {memoryState.total ? `${memoryState.total}개` : ""}
              </div>
            </div>
            {selectedAffinity ? (
              <div style={{ color: affinityColor(selectedAffinity.score), fontWeight: 950, textAlign: "right" }}>
                <div>{selectedAffinity.relationshipLabel}</div>
                <div style={{ marginTop: 3, fontSize: 12 }}>
                  ♥ {clampScore(selectedAffinity.score)} · {selectedAffinity.label}
                </div>
              </div>
            ) : null}
          </div>

          {memoryState.character ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
                gap: 8,
                marginTop: 13,
              }}
            >
              {[
                ["역할", memoryState.character.role],
                ["관계 기억", memoryState.character.relationshipNote],
                ["감정 기억", memoryState.character.emotionNote],
                ["현재 상태", memoryState.character.status],
                ["인물 설정", memoryState.character.profile],
              ]
                .filter((item) => String(item[1] || "").trim())
                .map(([label, value]) => (
                  <div
                    key={label}
                    style={{
                      padding: "10px 11px",
                      borderRadius: 12,
                      border: `1px solid ${theme.borderSoft}`,
                      background: "rgba(0,0,0,0.12)",
                    }}
                  >
                    <div style={{ color: "#c7d2fe", fontSize: 11, fontWeight: 950 }}>{label}</div>
                    <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, wordBreak: "keep-all" }}>{value}</div>
                  </div>
                ))}
            </div>
          ) : null}

          {memoryState.error ? (
            <div style={{ marginTop: 10, color: "#fecaca", fontSize: 12 }}>{memoryState.error}</div>
          ) : null}
          <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
            {memoryState.memories.map((memory) => (
              <div
                key={`${selected.rosterId}-${memory.turnNo}`}
                style={{
                  padding: "11px 12px",
                  borderRadius: 14,
                  border: `1px solid ${theme.borderSoft}`,
                  background: "rgba(0,0,0,0.12)",
                }}
              >
                <div style={{ color: "#c7d2fe", fontSize: 11, fontWeight: 950 }}>{memory.turnNo}턴</div>
                <div style={{ marginTop: 5, fontSize: 13, lineHeight: 1.55, wordBreak: "keep-all" }}>{memory.summary}</div>
              </div>
            ))}
            {!memoryState.loading && !memoryState.memories.length ? (
              <div style={{ color: theme.muted, fontSize: 13 }}>아직 저장된 턴별 대화 기억은 없습니다. 위 인물 설정과 관계 기억은 채팅에 계속 반영됩니다.</div>
            ) : null}
          </div>
          {memoryState.loading ? (
            <div style={{ marginTop: 10, color: theme.muted, fontSize: 12 }}>개별 기억을 불러오는 중...</div>
          ) : null}
          {memoryState.hasMore ? (
            <button
              type="button"
              onClick={() => void loadMemories(selected, memoryState.offset)}
              disabled={memoryState.loading}
              style={{
                marginTop: 12,
                height: 34,
                padding: "0 13px",
                borderRadius: 11,
                border: `1px solid ${theme.borderSoft}`,
                background: theme.panel2,
                color: theme.text,
                cursor: memoryState.loading ? "default" : "pointer",
                fontWeight: 900,
              }}
            >
              기억 더보기
            </button>
          ) : null}
        </div>
      ) : (
        <div style={{ textAlign: "center", color: theme.muted, fontSize: 12 }}>
          이름이 있는 인물 노드를 누르면 호감도와 개별 장기기억이 여기에 열립니다.
        </div>
      )}
    </div>
  );
}
