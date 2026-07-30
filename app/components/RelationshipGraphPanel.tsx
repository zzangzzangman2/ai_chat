"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isContextualSymmetricRelationship } from "@/lib/relationship_context";

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
  source: "manual" | "structured" | "identity" | "contextual";
  isManual: boolean;
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
  job: string;
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
  job: string;
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

type RelationEditorState = {
  open: boolean;
  subjectName: string;
  objectName: string;
  relation: string;
  details: string;
  isManual: boolean;
  saving: boolean;
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

const emptyRelationEditor: RelationEditorState = {
  open: false,
  subjectName: "",
  objectName: "",
  relation: "",
  details: "",
  isManual: false,
  saving: false,
  error: "",
};

const COMMON_RELATIONSHIPS = [
  "부부",
  "배우자",
  "연인",
  "가족",
  "아버지",
  "어머니",
  "딸",
  "아들",
  "손녀",
  "손자",
  "형제자매",
  "친구",
  "절친",
  "소꿉친구",
  "같은 반 친구",
  "동료",
  "상사",
  "부하 직원",
  "스승",
  "제자",
  "보호자",
  "이웃",
  "라이벌",
  "원수",
  "가해자",
  "피해자",
  "지인",
];

function RelationshipEditorModal({
  theme,
  state,
  people,
  onChange,
  onSubjectChange,
  onObjectChange,
  onClose,
  onSave,
  onResetAutomatic,
}: {
  theme: Theme;
  state: RelationEditorState;
  people: Array<{ name: string; job: string; isPersona: boolean }>;
  onChange: (patch: Partial<RelationEditorState>) => void;
  onSubjectChange: (name: string) => void;
  onObjectChange: (name: string) => void;
  onClose: () => void;
  onSave: () => void;
  onResetAutomatic: () => void;
}) {
  if (!state.open) return null;
  const selectStyle = {
    width: "100%",
    height: 42,
    borderRadius: 12,
    border: `1px solid ${theme.borderSoft}`,
    background: theme.panel2,
    color: theme.text,
    padding: "0 11px",
    outline: "none",
    fontWeight: 850,
  } as const;

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !state.saving) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1400,
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "rgba(2,6,23,0.76)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="인물 관계 변경"
        style={{
          width: "min(620px, calc(100vw - 32px))",
          maxHeight: "min(760px, calc(100vh - 32px))",
          overflowY: "auto",
          borderRadius: 24,
          border: "1px solid rgba(129,140,248,0.38)",
          background:
            "radial-gradient(circle at 10% 0%, rgba(99,102,241,0.22), transparent 32%), rgba(15,23,42,0.98)",
          color: theme.text,
          boxShadow: "0 32px 90px rgba(0,0,0,0.56)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 2,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
            padding: "17px 18px 14px",
            borderBottom: `1px solid ${theme.borderSoft}`,
            background: "rgba(15,23,42,0.95)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div style={{ display: "flex", gap: 11, minWidth: 0 }}>
            <div
              style={{
                width: 38,
                height: 38,
                flex: "0 0 auto",
                display: "grid",
                placeItems: "center",
                borderRadius: 13,
                background: "linear-gradient(145deg, rgba(99,102,241,0.35), rgba(236,72,153,0.28))",
                border: "1px solid rgba(165,180,252,0.34)",
              }}
            >
              ↔
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 17, fontWeight: 950 }}>관계 변경</div>
              <div style={{ marginTop: 4, color: theme.muted, fontSize: 11.5, lineHeight: 1.45 }}>
                수동 설정은 자동 추론보다 우선합니다. 언제든 자동 갱신으로 되돌릴 수 있어요.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={state.saving}
            aria-label="닫기"
            style={{
              width: 34,
              height: 34,
              flex: "0 0 auto",
              borderRadius: 11,
              border: `1px solid ${theme.borderSoft}`,
              background: theme.panel2,
              color: theme.text,
              cursor: state.saving ? "default" : "pointer",
              fontSize: 18,
              outline: "none",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 18 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) 34px minmax(0, 1fr)",
              alignItems: "end",
              gap: 8,
            }}
          >
            <label style={{ minWidth: 0 }}>
              <span style={{ display: "block", marginBottom: 7, color: "#c7d2fe", fontSize: 11, fontWeight: 950 }}>
                인물 1
              </span>
              <select
                value={state.subjectName}
                onChange={(event) => onSubjectChange(event.target.value)}
                disabled={state.saving}
                style={selectStyle}
              >
                {people.map((person) => (
                  <option key={`subject-${person.name}`} value={person.name}>
                    {person.name}{person.job ? ` · ${person.job}` : person.isPersona ? " · 주인공" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div
              aria-hidden
              style={{
                height: 42,
                display: "grid",
                placeItems: "center",
                color: "#a5b4fc",
                fontSize: 18,
                fontWeight: 950,
              }}
            >
              ↔
            </div>
            <label style={{ minWidth: 0 }}>
              <span style={{ display: "block", marginBottom: 7, color: "#c7d2fe", fontSize: 11, fontWeight: 950 }}>
                인물 2
              </span>
              <select
                value={state.objectName}
                onChange={(event) => onObjectChange(event.target.value)}
                disabled={state.saving}
                style={selectStyle}
              >
                {people.map((person) => (
                  <option key={`object-${person.name}`} value={person.name}>
                    {person.name}{person.job ? ` · ${person.job}` : person.isPersona ? " · 주인공" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginTop: 14,
              padding: "10px 12px",
              borderRadius: 14,
              border: `1px solid ${state.isManual ? "rgba(244,114,182,0.36)" : "rgba(34,211,238,0.28)"}`,
              background: state.isManual ? "rgba(236,72,153,0.09)" : "rgba(34,211,238,0.07)",
            }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 950 }}>
                {state.isManual ? "직접 설정된 관계" : "대화에서 자동 추론된 관계"}
              </div>
              <div style={{ marginTop: 3, color: theme.muted, fontSize: 10.5 }}>
                {state.isManual ? "AI가 임의로 덮어쓰지 않습니다." : "대화가 진행되면 연인·부부·원수 등으로 바뀔 수 있습니다."}
              </div>
            </div>
            <span
              style={{
                flex: "0 0 auto",
                padding: "4px 8px",
                borderRadius: 999,
                background: state.isManual ? "rgba(244,114,182,0.18)" : "rgba(34,211,238,0.15)",
                color: state.isManual ? "#fbcfe8" : "#a5f3fc",
                fontSize: 10,
                fontWeight: 950,
              }}
            >
              {state.isManual ? "수동 우선" : "자동 갱신"}
            </span>
          </div>

          <div style={{ marginTop: 17 }}>
            <div style={{ color: "#c7d2fe", fontSize: 11, fontWeight: 950 }}>빠른 선택</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 9 }}>
              {COMMON_RELATIONSHIPS.map((relation) => {
                const active = state.relation === relation;
                return (
                  <button
                    key={relation}
                    type="button"
                    onClick={() => onChange({ relation, error: "" })}
                    disabled={state.saving}
                    style={{
                      height: 30,
                      padding: "0 10px",
                      borderRadius: 999,
                      border: active
                        ? "1px solid rgba(244,114,182,0.82)"
                        : `1px solid ${theme.borderSoft}`,
                      background: active ? "rgba(236,72,153,0.18)" : "rgba(255,255,255,0.025)",
                      color: active ? "#fbcfe8" : theme.text,
                      cursor: state.saving ? "default" : "pointer",
                      fontSize: 11,
                      fontWeight: 900,
                      outline: "none",
                    }}
                  >
                    {relation}
                  </button>
                );
              })}
            </div>
          </div>

          <label style={{ display: "block", marginTop: 17 }}>
            <span style={{ display: "block", marginBottom: 7, color: "#c7d2fe", fontSize: 11, fontWeight: 950 }}>
              관계명
            </span>
            <input
              value={state.relation}
              onChange={(event) => onChange({ relation: event.target.value, error: "" })}
              placeholder="예: 부부, 같은 반 친구, 계약 관계"
              maxLength={40}
              disabled={state.saving}
              style={{
                ...selectStyle,
                fontWeight: 800,
              }}
            />
          </label>

          <label style={{ display: "block", marginTop: 14 }}>
            <span style={{ display: "block", marginBottom: 7, color: "#c7d2fe", fontSize: 11, fontWeight: 950 }}>
              관계 세부사항 <span style={{ color: theme.muted, fontWeight: 700 }}>(선택)</span>
            </span>
            <textarea
              value={state.details}
              onChange={(event) => onChange({ details: event.target.value, error: "" })}
              placeholder="예: 오랜 연애 끝에 결혼했고 서로를 배우자로 대함"
              maxLength={500}
              disabled={state.saving}
              style={{
                width: "100%",
                minHeight: 78,
                resize: "vertical",
                borderRadius: 13,
                border: `1px solid ${theme.borderSoft}`,
                background: theme.panel2,
                color: theme.text,
                padding: "10px 11px",
                outline: "none",
                lineHeight: 1.5,
                boxSizing: "border-box",
              }}
            />
          </label>

          {state.error ? (
            <div
              style={{
                marginTop: 12,
                padding: "9px 11px",
                borderRadius: 12,
                background: "rgba(239,68,68,0.11)",
                border: "1px solid rgba(248,113,113,0.28)",
                color: "#fecaca",
                fontSize: 11.5,
              }}
            >
              {state.error}
            </div>
          ) : null}
        </div>

        <div
          style={{
            position: "sticky",
            bottom: 0,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            padding: "13px 18px 16px",
            borderTop: `1px solid ${theme.borderSoft}`,
            background: "rgba(15,23,42,0.96)",
            backdropFilter: "blur(12px)",
          }}
        >
          <button
            type="button"
            onClick={onResetAutomatic}
            disabled={!state.isManual || state.saving}
            style={{
              height: 38,
              padding: "0 12px",
              borderRadius: 12,
              border: `1px solid ${theme.borderSoft}`,
              background: "transparent",
              color: state.isManual ? "#a5f3fc" : theme.muted,
              cursor: state.isManual && !state.saving ? "pointer" : "default",
              fontWeight: 900,
              opacity: state.isManual ? 1 : 0.55,
              outline: "none",
            }}
          >
            자동 추론으로 전환
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={state.saving}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 12,
                border: `1px solid ${theme.borderSoft}`,
                background: theme.panel2,
                color: theme.text,
                cursor: state.saving ? "default" : "pointer",
                fontWeight: 900,
                outline: "none",
              }}
            >
              취소
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={state.saving || !state.relation.trim() || state.subjectName === state.objectName}
              style={{
                height: 38,
                padding: "0 17px",
                borderRadius: 12,
                border: "1px solid rgba(244,114,182,0.72)",
                background: "linear-gradient(135deg, rgba(99,102,241,0.88), rgba(236,72,153,0.88))",
                color: "#fff",
                cursor:
                  state.saving || !state.relation.trim() || state.subjectName === state.objectName
                    ? "default"
                    : "pointer",
                fontWeight: 950,
                opacity: state.saving || !state.relation.trim() || state.subjectName === state.objectName ? 0.58 : 1,
                outline: "none",
              }}
            >
              {state.saving ? "저장 중..." : "이 관계로 저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

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

function visiblePersonName(value: unknown) {
  return String(value || "").trim().replace(/^이름\s*미상$/u, "");
}

function ellipsis(value: string, max: number) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

// 서로 방향이 없는 관계. 화살촉을 붙이지 않고 선으로만 잇는다.
const SYMMETRIC_RELATIONS = new Set([
  "부부", "배우자", "연인", "친구", "절친", "소꿉친구", "같은 반 친구",
  "동급생", "같은 학교", "동료", "동맹", "라이벌", "원수", "이웃", "지인",
  "형제자매", "자매", "형제",
]);

// 세대가 벌어져야 성립하는 관계 → 나이 검증에 쓰인다.
const GENERATION_GAP: Record<string, number> = {
  딸: 12, 아들: 12, 자녀: 12,
  손녀: 28, 손자: 28, 손자녀: 28,
};

// vitals가 채우는 자리표시 문구. 노드 부제로 띄우면 정보 없이 자리만 차지한다.
const FILLER_ROLE_LABELS = new Set(["관계의 기준 인물", "페르소나", "관계 미정", "이름 미상"]);

// "누가 이 사람의 부모/조부모인가"를 주장하는 관계.
// 한 아이에 두 명이 붙는 것은 아빠·엄마라서 정상이다. 세 명 이상일 때만 의심한다.
const PARENT_CLAIM_RELATIONS = new Set(["딸", "아들", "자녀", "손녀", "손자", "손자녀"]);

// 한 아이를 두고 부모끼리 세대가 어긋나면(한쪽은 딸, 한쪽은 손녀) 둘 중 하나가 틀렸다.
const PARENT_GENERATION: Record<string, number> = {
  딸: 1, 아들: 1, 자녀: 1,
  손녀: 2, 손자: 2, 손자녀: 2,
};

type RelationGroup = {
  key: string;
  relation: string;
  label: string;
  memberKeys: string[];
  edgeIds: Set<string>;
  tier: number;
  // "family" = 같은 아이의 친부·친모. 자리만 나란히 잡고 상자는 그리지 않는다.
  //   부모라는 사실이 곧 부부/연인은 아니므로, 테두리로 묶으면 없는 관계를 주장하게 된다.
  // "clique" = 같은 반·같은 학교 묶음. 상자로 묶어 N² 간선을 흡수한다.
  variant: "family" | "clique";
};

/**
 * 같은 반 친구처럼 대칭 관계가 N명 사이에 전부 연결되면 간선이 N*(N-1)/2개로 폭발한다.
 * (4명이면 6개, 10명이면 45개) 화면이 화살표로 뒤덮이는 원인이라,
 * slotKey 앞부분(예: "한림예고:1:5")이 같은 관계들을 하나의 그룹으로 묶어
 * 간선 대신 "묶음 상자"로 표현한다.
 */
function buildRelationGroups(relations: Relation[], excludedKeys = new Set<string>()) {
  const byKey = new Map<
    string,
    { relation: string; label: string; memberKeys: string[]; candidates: Relation[] }
  >();
  for (const relation of relations) {
    if (!SYMMETRIC_RELATIONS.has(relation.relation)) continue;
    const parts = String(relation.slotKey || "").split(":");
    if (parts.length < 2) continue;
    const prefix = parts.slice(0, -1).join(":");
    if (!prefix) continue;
    const key = `${relation.relation}|${prefix}`;
    const entry =
      byKey.get(key) ||
      {
        relation: relation.relation,
        label: groupLabel(relation.relation, prefix),
        memberKeys: [] as string[],
        candidates: [] as Relation[],
      };
    for (const memberKey of [relation.subjectKey, relation.objectKey]) {
      // 이미 부모 묶음에 들어간 인물은 그쪽을 우선한다(주인공 옆자리를 지키기 위해).
      if (excludedKeys.has(memberKey)) continue;
      if (!entry.memberKeys.includes(memberKey)) entry.memberKeys.push(memberKey);
    }
    entry.candidates.push(relation);
    byKey.set(key, entry);
  }

  const groups: RelationGroup[] = [];
  for (const [key, entry] of byKey) {
    // 2명뿐이면 선 하나가 오히려 명확하다. 3명 이상만 묶는다.
    if (entry.memberKeys.length < 3) continue;
    const memberSet = new Set(entry.memberKeys);
    // 양쪽 모두 묶음 안에 있는 간선만 상자로 흡수한다.
    // 한쪽이 빠진 간선은 정보가 사라지지 않게 화살표로 남긴다.
    const edgeIds = new Set(
      entry.candidates
        .filter((relation) => memberSet.has(relation.subjectKey) && memberSet.has(relation.objectKey))
        .map((relation) => relation.id)
    );
    groups.push({
      key,
      relation: entry.relation,
      label: entry.label,
      memberKeys: entry.memberKeys,
      edgeIds,
      tier: -1,
      variant: "clique",
    });
  }
  return groups;
}

/**
 * 한 아이의 친부·친모는 아이를 기준으로 가장 가까운 자리에 놓아야 읽기 쉽다.
 * 같은 줄에 나란히 세우고, 아이는 바로 아래 줄에 둔다.
 *
 * 단 테두리로 묶지는 않는다 — 부모라는 사실이 부부/연인을 뜻하지는 않기 때문에
 * 상자로 감싸면 데이터에 없는 관계를 화면이 주장하게 된다.
 * 누가 부모인지는 양쪽에서 아이로 가는 화살표가 그대로 말해준다.
 */
function buildCoParentGroups(relations: Relation[]) {
  const byChild = new Map<string, { childName: string; parentKeys: string[] }>();
  for (const relation of relations) {
    if (!PARENT_CLAIM_RELATIONS.has(relation.relation)) continue;
    const childName = visiblePersonName(relation.objectName);
    if (!childName) continue;
    const entry = byChild.get(relation.objectKey) || { childName, parentKeys: [] as string[] };
    if (!entry.parentKeys.includes(relation.subjectKey)) entry.parentKeys.push(relation.subjectKey);
    byChild.set(relation.objectKey, entry);
  }
  const groups: RelationGroup[] = [];
  for (const [childKey, entry] of byChild) {
    if (entry.parentKeys.length < 2) continue;
    groups.push({
      key: `coparent|${childKey}`,
      relation: "부모",
      label: "",
      memberKeys: entry.parentKeys,
      edgeIds: new Set<string>(),
      tier: -1,
      variant: "family",
    });
  }
  return groups;
}

function groupLabel(relation: string, prefix: string) {
  const [school, grade, classNo] = prefix.split(":");
  const bits: string[] = [];
  if (school && !/^\d+$/.test(school)) bits.push(school);
  if (Number(grade) > 0) bits.push(`${Number(grade)}학년`);
  if (Number(classNo) > 0) bits.push(`${Number(classNo)}반`);
  return bits.length ? `${bits.join(" ")} · ${relation}` : relation;
}

type Warning = { id: string; text: string };

/**
 * 자동 추출된 관계는 서로 모순될 수 있다. 눈으로 잡기 어려운 것만 짚어준다.
 *  1) 한 아이에 부모가 3명 이상 → 하나는 오탐 (2명은 아빠·엄마라서 정상)
 *  2) 부모끼리 세대가 어긋남 (한쪽은 딸, 한쪽은 손녀로 기록)
 *  3) 나이 차가 세대 관계로 불가능 (16세가 14세의 조부모 등)
 */
function validateRelations(relations: Relation[], nodeByKey: Map<string, GraphNode>) {
  const warnings: Warning[] = [];

  const claims = new Map<string, { name: string; claims: string[]; generations: Set<number> }>();
  for (const relation of relations) {
    if (!PARENT_CLAIM_RELATIONS.has(relation.relation)) continue;
    const objectName = visiblePersonName(relation.objectName);
    if (!objectName) continue;
    const entry =
      claims.get(relation.objectKey) ||
      { name: objectName, claims: [] as string[], generations: new Set<number>() };
    const claim = `${relation.subjectName}의 ${relation.relation}`;
    if (!entry.claims.includes(claim)) entry.claims.push(claim);
    const generation = PARENT_GENERATION[relation.relation];
    if (generation) entry.generations.add(generation);
    claims.set(relation.objectKey, entry);
  }
  for (const [key, entry] of claims) {
    // 아빠·엄마 두 명은 정상이므로 경고하지 않는다.
    if (entry.claims.length >= 3) {
      warnings.push({
        id: `parent-count-${key}`,
        text: `${entry.name}의 부모가 ${entry.claims.length}명으로 기록돼 있습니다 («${entry.claims.join("», «")}»). 하나는 오탐일 가능성이 큽니다.`,
      });
      continue;
    }
    if (entry.generations.size >= 2) {
      warnings.push({
        id: `parent-generation-${key}`,
        text: `${entry.name}을(를) «${entry.claims.join("», «")}»로 기록해 세대가 어긋납니다. 부모/조부모 중 한쪽이 잘못 잡혔을 수 있습니다.`,
      });
    }
  }

  for (const relation of relations) {
    const gap = GENERATION_GAP[relation.relation];
    if (!gap) continue;
    const subject = nodeByKey.get(relation.subjectKey);
    const object = nodeByKey.get(relation.objectKey);
    if (!subject || !object || subject.age <= 0 || object.age <= 0) continue;
    if (subject.age - object.age >= gap) continue;
    warnings.push({
      id: `age-conflict-${relation.id}`,
      text: `${subject.name}(${subject.age}세)이 ${object.name}(${object.age}세)의 ${relation.relation} 관계가 되려면 최소 ${gap}살 차이가 필요합니다.`,
    });
  }

  return warnings;
}

/* ------------------------------------------------------------ graph canvas */

const NODE_W = 186;
const NODE_H = 82;
const CELL_GAP = 16;
const TIER_GAP = 124;
const GROUP_PAD = 14;
const GROUP_LABEL_H = 24;
const GROUP_MAX_COLS = 4;
const CANVAS_W = 1040;

type Cell =
  | { kind: "node"; key: string; width: number; height: number; node: GraphNode }
  | { kind: "group"; key: string; width: number; height: number; group: RelationGroup; rows: GraphNode[][] };

function chunk<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function RelationshipMap({
  nodes,
  relations,
  affinities,
  selected,
  theme,
  onSelect,
  onEditRelation,
}: {
  nodes: GraphNode[];
  relations: Relation[];
  affinities: Affinity[];
  selected: SelectedPerson | null;
  theme: Theme;
  onSelect: (person: SelectedPerson) => void;
  onEditRelation: (relation: Relation) => void;
}) {
  const layout = useMemo(() => {
    const personaFallback: GraphNode = {
      id: "persona",
      key: "persona",
      name: "주인공",
      rosterId: "",
      age: 0,
      ageSource: "",
      job: "",
      role: "페르소나",
      relationshipNote: "",
      profile: "",
      isPersona: true,
      isUnknown: false,
      updatedAt: 0,
    };
    const persona =
      nodes.find((node) => node.isPersona || node.key === "persona") || personaFallback;

    const visible = nodes.filter(
      (node) => !node.isUnknown && Boolean(visiblePersonName(node.name))
    );
    const nodeByKey = new Map(visible.map((node) => [node.key, node]));
    nodeByKey.set(persona.key, persona);

    const usable = relations.filter(
      (relation) =>
        Boolean(visiblePersonName(relation.objectName)) &&
        nodeByKey.has(relation.subjectKey) &&
        nodeByKey.has(relation.objectKey) &&
        relation.subjectKey !== relation.objectKey
    );

    // 부모 묶음이 우선. 같은 아이를 둔 아빠·엄마는 무조건 같은 줄에 나란히 세운다.
    const coParentGroups = buildCoParentGroups(usable);
    const coParentMemberKeys = new Set(coParentGroups.flatMap((group) => group.memberKeys));
    const groups = [...coParentGroups, ...buildRelationGroups(usable, coParentMemberKeys)];
    const groupedEdgeIds = new Set(groups.flatMap((group) => [...group.edgeIds]));
    const groupOfNode = new Map<string, RelationGroup>();
    for (const group of groups) {
      for (const memberKey of group.memberKeys) {
        if (!groupOfNode.has(memberKey)) groupOfNode.set(memberKey, group);
      }
    }
    const pairEdges = usable.filter((relation) => !groupedEdgeIds.has(relation.id));

    // 주인공에서 시작하는 너비 우선 탐색으로 단계(tier)를 정한다.
    // 가까운 인물이 위, 먼 인물이 아래 → 화살표가 대체로 아래로만 흘러 교차가 줄어든다.
    //
    // 이때 아빠·엄마는 하나의 지점으로 합쳐서 거리를 센다. 합치지 않으면
    // 엄마가 "주인공 → 아이 → 엄마"로 두 단계 아래로 밀려나 남남처럼 보인다.
    const unionParent = new Map<string, string>();
    const findRoot = (key: string): string => {
      const parent = unionParent.get(key);
      if (!parent || parent === key) return key;
      const root = findRoot(parent);
      unionParent.set(key, root);
      return root;
    };
    for (const group of coParentGroups) {
      for (let index = 1; index < group.memberKeys.length; index += 1) {
        const rootA = findRoot(group.memberKeys[0]);
        const rootB = findRoot(group.memberKeys[index]);
        if (rootA !== rootB) unionParent.set(rootB, rootA);
      }
    }

    const adjacency = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      if (!adjacency.has(a)) adjacency.set(a, new Set());
      adjacency.get(a)!.add(b);
    };
    for (const edge of pairEdges) {
      const from = findRoot(edge.subjectKey);
      const to = findRoot(edge.objectKey);
      if (from === to) continue;
      link(from, to);
      link(to, from);
    }

    const rootTier = new Map<string, number>();
    rootTier.set(findRoot(persona.key), 0);
    const queue: string[] = [findRoot(persona.key)];
    while (queue.length) {
      const key = queue.shift() as string;
      const tier = rootTier.get(key) ?? 0;
      for (const next of adjacency.get(key) || []) {
        if (rootTier.has(next)) continue;
        rootTier.set(next, tier + 1);
        queue.push(next);
      }
    }

    const tierOf = new Map<string, number>();
    for (const node of [persona, ...visible]) {
      const tier = rootTier.get(findRoot(node.key));
      if (typeof tier === "number") tierOf.set(node.key, tier);
    }

    // 그룹은 구성원 중 가장 가까운 단계에 놓고, 나머지 구성원도 같은 줄로 끌어온다.
    for (const group of groups) {
      const memberTiers = group.memberKeys
        .map((key) => tierOf.get(key))
        .filter((tier): tier is number => typeof tier === "number");
      if (!memberTiers.length) continue;
      group.tier = Math.min(...memberTiers);
      for (const memberKey of group.memberKeys) tierOf.set(memberKey, group.tier);
    }

    const placedGroups = groups.filter((group) => group.tier >= 0);
    const groupByKey = new Map(placedGroups.map((group) => [group.key, group]));

    // 어떤 관계에도 닿지 않은 인물은 그래프에 띄우지 않고 아래 트레이로 내린다.
    const tray = visible.filter(
      (node) => node.key !== persona.key && !tierOf.has(node.key)
    );

    const cellsByTier = new Map<number, Cell[]>();
    const consumedGroupKeys = new Set<string>();
    const pushCell = (tier: number, cell: Cell) => {
      const list = cellsByTier.get(tier) || [];
      list.push(cell);
      cellsByTier.set(tier, list);
    };

    const orderedKeys = [...tierOf.keys()].sort((a, b) => {
      const nameA = nodeByKey.get(a)?.name || "";
      const nameB = nodeByKey.get(b)?.name || "";
      return nameA.localeCompare(nameB, "ko");
    });

    for (const key of orderedKeys) {
      const node = nodeByKey.get(key);
      if (!node) continue;
      const tier = tierOf.get(key) ?? 0;
      const group = key === persona.key ? undefined : groupOfNode.get(key);
      if (group && groupByKey.has(group.key)) {
        if (consumedGroupKeys.has(group.key)) continue;
        consumedGroupKeys.add(group.key);
        const members = group.memberKeys
          .map((memberKey) => nodeByKey.get(memberKey))
          .filter((member): member is GraphNode => Boolean(member));
        const rows = chunk(members, GROUP_MAX_COLS);
        const widest = Math.max(1, ...rows.map((row) => row.length));
        // family는 상자·라벨을 그리지 않으므로 여백도 잡지 않는다(자리만 나란히).
        const boxed = group.variant === "clique";
        const pad = boxed ? GROUP_PAD : 0;
        const labelHeight = boxed ? GROUP_LABEL_H : 0;
        pushCell(group.tier, {
          kind: "group",
          key: group.key,
          group,
          rows,
          width: pad * 2 + widest * NODE_W + (widest - 1) * CELL_GAP,
          height: pad * 2 + labelHeight + rows.length * NODE_H + (rows.length - 1) * CELL_GAP,
        });
        continue;
      }
      pushCell(tier, { kind: "node", key, node, width: NODE_W, height: NODE_H });
    }

    // 각 단계를 가로 중앙 정렬해 배치한다.
    const positions = new Map<string, { x: number; y: number }>();
    const groupBoxes: Array<{ cell: Cell; x: number; y: number }> = [];
    const tiers = [...cellsByTier.keys()].sort((a, b) => a - b);
    let cursorY = 70;
    let contentWidth = CANVAS_W;

    for (const tier of tiers) {
      const cells = cellsByTier.get(tier) || [];
      const rowWidth =
        cells.reduce((sum, cell) => sum + cell.width, 0) + Math.max(0, cells.length - 1) * CELL_GAP;
      contentWidth = Math.max(contentWidth, rowWidth + 80);
      const rowHeight = Math.max(...cells.map((cell) => cell.height), NODE_H);
      let cursorX = (Math.max(CANVAS_W, rowWidth + 80) - rowWidth) / 2;
      for (const cell of cells) {
        const centerY = cursorY + rowHeight / 2;
        if (cell.kind === "node") {
          positions.set(cell.key, { x: cursorX + cell.width / 2, y: centerY });
        } else {
          const boxTop = centerY - cell.height / 2;
          const boxed = cell.group.variant === "clique";
          const innerTop = boxTop + (boxed ? GROUP_PAD + GROUP_LABEL_H : 0);
          if (boxed) groupBoxes.push({ cell, x: cursorX, y: boxTop });
          cell.rows.forEach((row, rowIndex) => {
            const innerWidth = row.length * NODE_W + (row.length - 1) * CELL_GAP;
            const innerLeft = cursorX + (cell.width - innerWidth) / 2;
            row.forEach((member, columnIndex) => {
              positions.set(member.key, {
                x: innerLeft + columnIndex * (NODE_W + CELL_GAP) + NODE_W / 2,
                y: innerTop + rowIndex * (NODE_H + CELL_GAP) + NODE_H / 2,
              });
            });
          });
        }
        cursorX += cell.width + CELL_GAP;
      }
      cursorY += rowHeight + TIER_GAP;
    }

    const height = Math.max(360, cursorY - TIER_GAP + 70);
    const affinityByRoster = new Map(
      affinities.map((affinity) => [affinity.rosterId, affinity])
    );

    const edges = pairEdges
      .filter((relation) => positions.has(relation.subjectKey) && positions.has(relation.objectKey))
      .map((relation) => ({
        id: relation.id,
        from: relation.subjectKey,
        to: relation.objectKey,
        fromName: relation.subjectName,
        toName: visiblePersonName(relation.objectName),
        relation: relation.relation,
        symmetric:
          SYMMETRIC_RELATIONS.has(relation.relation) || isContextualSymmetricRelationship(relation.relation),
        row: relation,
      }));

    return {
      persona,
      nodeByKey,
      positions,
      groupBoxes,
      edges,
      tray,
      height,
      width: contentWidth,
      affinityByRoster,
      relationCount: usable.length,
      groupCount: placedGroups.length,
      collapsedEdgeCount: groupedEdgeIds.size,
    };
  }, [affinities, nodes, relations]);

  const renderNode = (node: GraphNode) => {
    const point = layout.positions.get(node.key);
    if (!point) return null;
    const isPersona = node.key === layout.persona.key;
    const affinity = node.rosterId ? layout.affinityByRoster.get(node.rosterId) : undefined;
    const evaluated = Boolean(affinity && affinity.lastTurnNo > 0);
    const color = isPersona ? "#67e8f9" : evaluated ? affinityColor(affinity!.score) : "#64748b";
    const clickable = Boolean(node.rosterId);
    const active = clickable && selected?.rosterId === node.rosterId;
    const roleLabel = FILLER_ROLE_LABELS.has(String(node.role || "").trim())
      ? ""
      : String(node.role || "").trim();
    const affinityLabelText = FILLER_ROLE_LABELS.has(String(affinity?.relationshipLabel || "").trim())
      ? ""
      : String(affinity?.relationshipLabel || "").trim();
    const subtitle = isPersona ? "주인공" : ellipsis(node.job || roleLabel || affinityLabelText, 22);

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
        <title>
          {node.name}
          {node.age > 0 ? ` · ${node.age}세` : ""}
          {node.job ? ` · 직업: ${node.job}` : ""}
          {node.role ? ` · ${node.role}` : ""}
        </title>
        {active ? (
          <rect
            x={-NODE_W / 2 - 4}
            y={-NODE_H / 2 - 4}
            width={NODE_W + 8}
            height={NODE_H + 8}
            rx={15}
            fill="rgba(244,114,182,0.08)"
            stroke="#f9a8d4"
            strokeWidth="2"
          />
        ) : null}
        <rect
          x={-NODE_W / 2}
          y={-NODE_H / 2}
          width={NODE_W}
          height={NODE_H}
          rx={12}
          fill={isPersona ? "rgba(8,91,115,0.95)" : "rgba(15,23,42,0.96)"}
          stroke={color}
          strokeWidth={isPersona ? 2.4 : 1.5}
        />
        <text x="0" y={-20} textAnchor="middle" fill="#fff" fontSize="15" fontWeight="900">
          {ellipsis(node.name, 12)}
        </text>
        <text x="0" y={1} textAnchor="middle" fill={isPersona ? "#a5f3fc" : "#94a3b8"} fontSize="10.5" fontWeight="700">
          {subtitle}
        </text>
        <text x="0" y={25} textAnchor="middle" fill="#cbd5e1" fontSize="10.5" fontWeight="800">
          {node.age > 0 ? `${node.age}세` : "나이 미상"}
          {!isPersona
            ? evaluated
              ? `  ·  ♥ ${clampScore(affinity!.score)}`
              : "  ·  호감도 미평가"
            : ""}
        </text>
      </g>
    );
  };

  const allNodeKeys = [...layout.positions.keys()];

  return (
    <div
      style={{
        border: `1px solid ${theme.borderSoft}`,
        borderRadius: 22,
        overflowX: "auto",
        background:
          "radial-gradient(circle at 50% 6%, rgba(34,211,238,0.10), transparent 34%), rgba(255,255,255,0.018)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04), 0 20px 45px rgba(0,0,0,0.16)",
      }}
    >
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        aria-label="인물 관계도"
        style={{ display: "block", width: "100%", minWidth: 720, height: "auto" }}
      >
        <defs>
          <marker
            id="relmap-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#f472b6" />
          </marker>
        </defs>

        {/* 상자는 같은 반·같은 학교 묶음(clique)에만 그린다. 부모는 자리만 나란히 잡는다. */}
        {layout.groupBoxes.map(({ cell, x, y }) => {
          if (cell.kind !== "group") return null;
          return (
            <g key={`group-${cell.key}`}>
              <rect
                x={x}
                y={y}
                width={cell.width}
                height={cell.height}
                rx={18}
                fill="rgba(129,140,248,0.06)"
                stroke="rgba(129,140,248,0.42)"
                strokeWidth="1.4"
                strokeDasharray="7 5"
              />
              <text
                x={x + cell.width / 2}
                y={y + GROUP_PAD + 12}
                textAnchor="middle"
                fill="#c7d2fe"
                fontSize="12"
                fontWeight="900"
              >
                {cell.group.label} · {cell.rows.flat().length}명
              </text>
            </g>
          );
        })}

        {layout.edges.map((edge) => {
          const from = layout.positions.get(edge.from);
          const to = layout.positions.get(edge.to);
          if (!from || !to) return null;
          const sameRow = Math.abs(from.y - to.y) < 8;
          let path: string;
          if (sameRow) {
            // 같은 줄이면 아래로 살짝 돌려 노드를 관통하지 않게 한다.
            const dip = from.y + NODE_H / 2 + 34;
            path = `M ${from.x} ${from.y + NODE_H / 2} C ${from.x} ${dip}, ${to.x} ${dip}, ${to.x} ${to.y + NODE_H / 2}`;
          } else {
            const top = from.y < to.y ? from : to;
            const bottom = from.y < to.y ? to : from;
            const startY = top.y + NODE_H / 2;
            const endY = bottom.y - NODE_H / 2;
            const midY = (startY + endY) / 2;
            const start = from.y < to.y ? { x: from.x, y: startY } : { x: from.x, y: from.y - NODE_H / 2 };
            const end = from.y < to.y ? { x: to.x, y: endY } : { x: to.x, y: to.y + NODE_H / 2 };
            path = `M ${start.x} ${start.y} C ${start.x} ${midY}, ${end.x} ${midY}, ${end.x} ${end.y}`;
          }
          const label = ellipsis(edge.relation, 24);
          const labelWidth = Math.min(182, Math.max(54, label.length * 10 + 18));
          const labelX = (from.x + to.x) / 2;
          const labelY = (from.y + to.y) / 2;
          return (
            <g
              key={edge.id}
              role="button"
              tabIndex={0}
              aria-label={`${edge.fromName}와 ${edge.toName} 관계 ${edge.relation} 변경`}
              onClick={() => onEditRelation(edge.row)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onEditRelation(edge.row);
                }
              }}
              style={{
                cursor: "pointer",
                outline: "none",
              }}
            >
              <path
                d={path}
                fill="none"
                stroke={edge.symmetric ? "#818cf8" : "#f472b6"}
                strokeWidth={2}
                opacity={0.8}
                markerEnd={edge.symmetric ? undefined : "url(#relmap-arrow)"}
              >
                <title>
                  {edge.fromName} {edge.symmetric ? "↔" : "→"} {edge.toName}: {edge.relation}
                  {" · 클릭해서 관계 변경"}
                </title>
              </path>
              <rect
                x={labelX - labelWidth / 2}
                y={labelY - 10}
                width={labelWidth}
                height={20}
                rx={10}
                fill="rgba(15,23,42,0.94)"
                stroke={edge.symmetric ? "rgba(129,140,248,0.7)" : "rgba(244,114,182,0.7)"}
                strokeWidth="1"
              />
              <text
                x={labelX}
                y={labelY + 3.5}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize="10.5"
                fontWeight="900"
              >
                {label}
              </text>
            </g>
          );
        })}

        {allNodeKeys
          .map((key) => layout.nodeByKey.get(key))
          .filter((node): node is GraphNode => Boolean(node))
          .map(renderNode)}
      </svg>

      {layout.tray.length ? (
        <div
          style={{
            borderTop: `1px solid ${theme.borderSoft}`,
            padding: "11px 14px",
            display: "flex",
            alignItems: "center",
            gap: 9,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 900, color: theme.muted }}>
            현재 장면 인물 {layout.tray.length}명
          </span>
          {layout.tray.map((node) => {
            const affinity = node.rosterId ? layout.affinityByRoster.get(node.rosterId) : undefined;
            return (
              <button
                key={node.key}
                type="button"
                onClick={() => {
                  if (node.rosterId) onSelect({ name: node.name, rosterId: node.rosterId });
                }}
                title={node.job || node.role || node.name}
                style={{
                  padding: "6px 11px",
                  borderRadius: 999,
                  border:
                    selected?.rosterId === node.rosterId && node.rosterId
                      ? "1px solid rgba(244,114,182,0.9)"
                      : `1px solid ${theme.borderSoft}`,
                  background: theme.panel2,
                  color: theme.text,
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: node.rosterId ? "pointer" : "default",
                  outline: "none",
                  boxShadow: "none",
                }}
              >
                {node.name}
                {node.age > 0 ? ` · ${node.age}세` : ""}
                {affinity && affinity.lastTurnNo > 0 ? ` · ♥ ${clampScore(affinity.score)}` : ""}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

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
  const memoryRequestRef = useRef(0);
  const [memoryState, setMemoryState] = useState<MemoryState>(emptyMemoryState);
  const [relationEditor, setRelationEditor] =
    useState<RelationEditorState>(emptyRelationEditor);

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
    async (person: SelectedPerson, offset = 0, requestToken?: number) => {
      if (!chatId || !person.rosterId) return;
      const token = requestToken ?? (offset > 0 ? memoryRequestRef.current : ++memoryRequestRef.current);
      if (token !== memoryRequestRef.current) return;
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
        if (token !== memoryRequestRef.current) return;
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
        if (token !== memoryRequestRef.current) return;
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
      const token = ++memoryRequestRef.current;
      const activeElement = document.activeElement as { blur?: () => void } | null;
      activeElement?.blur?.();
      setSelected(person);
      setMemoryState(emptyMemoryState);
      void loadMemories(person, 0, token);
      window.setTimeout(() => {
        memoryPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 0);
    },
    [loadMemories]
  );

  useEffect(() => {
    memoryRequestRef.current += 1;
    setRelationEditor(emptyRelationEditor);
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

  const warnings = useMemo(() => {
    const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
    return validateRelations(
      relations.filter((relation) => Boolean(visiblePersonName(relation.objectName))),
      nodeByKey
    );
  }, [nodes, relations]);

  const evaluatedAffinities = affinities.filter((affinity) => affinity.lastTurnNo > 0).length;

  const relationList = useMemo(
    () => relations.filter((relation) => Boolean(visiblePersonName(relation.objectName))),
    [relations]
  );

  const relationshipPeople = useMemo(() => {
    const people = new Map<string, { name: string; job: string; isPersona: boolean }>();
    for (const node of nodes) {
      const name = visiblePersonName(node.name);
      if (!name || node.isUnknown) continue;
      people.set(name, {
        name,
        job: String(node.job || "").trim(),
        isPersona: Boolean(node.isPersona || node.key === "persona"),
      });
    }
    if (personaName && !people.has(personaName)) {
      people.set(personaName, { name: personaName, job: "", isPersona: true });
    }
    return [...people.values()].sort(
      (a, b) => Number(b.isPersona) - Number(a.isPersona) || a.name.localeCompare(b.name, "ko")
    );
  }, [nodes, personaName]);

  const relationForPair = useCallback(
    (subjectName: string, objectName: string) => {
      const subject = String(subjectName || "").trim().toLocaleLowerCase("ko-KR");
      const object = String(objectName || "").trim().toLocaleLowerCase("ko-KR");
      if (!subject || !object) return null;
      return (
        relationList.find((relation) => {
          const left = String(relation.subjectName || "").trim().toLocaleLowerCase("ko-KR");
          const right = String(relation.objectName || "").trim().toLocaleLowerCase("ko-KR");
          return (
            (left === subject && right === object) ||
            (left === object && right === subject)
          );
        }) || null
      );
    },
    [relationList]
  );

  const openRelationEditor = useCallback(
    (relation?: Relation | null) => {
      const fallbackSubject =
        relationshipPeople.find((person) => person.isPersona)?.name ||
        relationshipPeople[0]?.name ||
        "";
      const fallbackObject =
        relationshipPeople.find((person) => person.name !== fallbackSubject)?.name || "";
      const current =
        relation || relationForPair(fallbackSubject, fallbackObject);
      setRelationEditor({
        open: true,
        subjectName: current?.subjectName || fallbackSubject,
        objectName: visiblePersonName(current?.objectName) || fallbackObject,
        relation: current?.relation || "",
        details: current?.isManual ? String(current.objectRole || "") : "",
        isManual: Boolean(current?.isManual),
        saving: false,
        error: "",
      });
    },
    [relationshipPeople, relationForPair]
  );

  const changeEditorPair = useCallback(
    (subjectName: string, objectName: string) => {
      const current = relationForPair(subjectName, objectName);
      setRelationEditor((previous) => ({
        ...previous,
        subjectName,
        objectName,
        relation: current?.relation || "",
        details: current?.isManual ? String(current.objectRole || "") : "",
        isManual: Boolean(current?.isManual),
        error: "",
      }));
    },
    [relationForPair]
  );

  const applyRelationshipResponse = useCallback((body: GraphResponse) => {
    setPersonaName(String(body.personaName || ""));
    setNodes(Array.isArray(body.nodes) ? body.nodes : []);
    setRelations(Array.isArray(body.relations) ? body.relations : []);
    setAffinities(Array.isArray(body.affinities) ? body.affinities : []);
  }, []);

  const saveRelationship = useCallback(async () => {
    if (!chatId || relationEditor.saving) return;
    if (
      !relationEditor.subjectName ||
      !relationEditor.objectName ||
      relationEditor.subjectName === relationEditor.objectName
    ) {
      setRelationEditor((previous) => ({
        ...previous,
        error: "서로 다른 두 인물을 선택해 주세요.",
      }));
      return;
    }
    if (!relationEditor.relation.trim()) {
      setRelationEditor((previous) => ({ ...previous, error: "관계명을 입력해 주세요." }));
      return;
    }
    setRelationEditor((previous) => ({ ...previous, saving: true, error: "" }));
    try {
      const response = await fetch("/api/chat/relationships", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          subjectName: relationEditor.subjectName,
          objectName: relationEditor.objectName,
          relation: relationEditor.relation,
          details: relationEditor.details,
        }),
      });
      const body = (await response.json().catch(() => null)) as GraphResponse | null;
      if (!response.ok || !body?.ok) throw new Error(body?.error || "관계를 저장하지 못했습니다.");
      applyRelationshipResponse(body);
      setRelationEditor(emptyRelationEditor);
    } catch (cause: any) {
      setRelationEditor((previous) => ({
        ...previous,
        saving: false,
        error: String(cause?.message || "관계를 저장하지 못했습니다."),
      }));
    }
  }, [applyRelationshipResponse, chatId, relationEditor]);

  const resetRelationshipAutomatic = useCallback(async () => {
    if (!chatId || relationEditor.saving || !relationEditor.isManual) return;
    setRelationEditor((previous) => ({ ...previous, saving: true, error: "" }));
    try {
      const response = await fetch("/api/chat/relationships", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId,
          subjectName: relationEditor.subjectName,
          objectName: relationEditor.objectName,
        }),
      });
      const body = (await response.json().catch(() => null)) as GraphResponse | null;
      if (!response.ok || !body?.ok) throw new Error(body?.error || "자동 추론으로 전환하지 못했습니다.");
      applyRelationshipResponse(body);
      setRelationEditor(emptyRelationEditor);
    } catch (cause: any) {
      setRelationEditor((previous) => ({
        ...previous,
        saving: false,
        error: String(cause?.message || "자동 추론으로 전환하지 못했습니다."),
      }));
    }
  }, [applyRelationshipResponse, chatId, relationEditor]);

  const manualRelationCount = relations.filter((relation) => relation.isManual).length;

  return (
    <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
      <RelationshipEditorModal
        theme={theme}
        state={relationEditor}
        people={relationshipPeople}
        onChange={(patch) => setRelationEditor((previous) => ({ ...previous, ...patch }))}
        onSubjectChange={(name) => changeEditorPair(name, relationEditor.objectName)}
        onObjectChange={(name) => changeEditorPair(relationEditor.subjectName, name)}
        onClose={() => {
          if (!relationEditor.saving) setRelationEditor(emptyRelationEditor);
        }}
        onSave={() => void saveRelationship()}
        onResetAutomatic={() => void resetRelationshipAutomatic()}
      />
      <div
        style={{
          border: `1px solid ${theme.borderSoft}`,
          background: `radial-gradient(circle at 10% 0%, rgba(99,102,241,0.18), transparent 34%), ${theme.panel}`,
          borderRadius: 20,
          padding: 16,
          boxShadow: "0 18px 45px rgba(0,0,0,0.18)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 360px", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ fontSize: 21 }}>🕸️</span>
              <span style={{ fontSize: 18, fontWeight: 950 }}>인물 관계도</span>
            </div>
            <div style={{ marginTop: 6, color: theme.muted, fontSize: 12, lineHeight: 1.5 }}>
              주인공에서 가까운 인물이 위, 먼 인물이 아래입니다. 분홍 화살표는 방향이 있는
              관계, 보라 선은 서로 대등한 관계, <b>보라 점선 상자</b>는 같은 반·같은 학교
              묶음입니다. 같은 아이의 친부·친모는 같은 줄에 나란히 놓이지만, 부모라는 사실이
              부부를 뜻하지는 않으므로 따로 묶지 않습니다. 관계 라벨을 누르면 직접 변경할 수
              있습니다.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => openRelationEditor(relationList[0])}
              disabled={relationshipPeople.length < 2}
              style={{
                height: 36,
                padding: "0 13px",
                borderRadius: 12,
                border: "1px solid rgba(244,114,182,0.58)",
                background: "linear-gradient(135deg, rgba(99,102,241,0.24), rgba(236,72,153,0.18))",
                color: "#fce7f3",
                cursor: relationshipPeople.length >= 2 ? "pointer" : "default",
                fontWeight: 950,
                opacity: relationshipPeople.length >= 2 ? 1 : 0.5,
                outline: "none",
                whiteSpace: "nowrap",
              }}
            >
              관계 변경
            </button>
            <button
              type="button"
              onClick={() => void loadGraph()}
              disabled={loading}
              style={{
                height: 36,
                padding: "0 12px",
                borderRadius: 12,
                border: `1px solid ${theme.borderSoft}`,
                background: theme.panel2,
                color: theme.text,
                cursor: loading ? "default" : "pointer",
                fontWeight: 900,
                opacity: loading ? 0.65 : 1,
                outline: "none",
                whiteSpace: "nowrap",
              }}
            >
              {loading ? "동기화 중" : "새로고침"}
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 13 }}>
          {[
            `주인공 ${personaName || "미설정"}`,
            `인물 ${nodes.length}`,
            `관계 ${relationList.length}`,
            `호감도 평가 ${evaluatedAffinities}/${affinities.length}`,
            ...(manualRelationCount > 0 ? [`직접 설정 ${manualRelationCount}`] : []),
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

      {warnings.length ? (
        <div
          style={{
            border: "1px solid rgba(251,191,36,0.42)",
            background: "rgba(251,191,36,0.08)",
            borderRadius: 18,
            padding: 14,
          }}
        >
          <div style={{ fontWeight: 950, fontSize: 13, color: "#fde68a" }}>
            ⚠️ 서로 어긋나는 관계 {warnings.length}건
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: theme.muted }}>
            자동 추출된 관계가 충돌합니다. 이 내용도 그대로 채팅 기억에 들어가니, 인물 설정에서
            틀린 쪽을 고쳐주세요.
          </div>
          <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
            {warnings.map((warning) => (
              <div
                key={warning.id}
                style={{
                  padding: "9px 11px",
                  borderRadius: 11,
                  background: "rgba(0,0,0,0.20)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  wordBreak: "keep-all",
                }}
              >
                {warning.text}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <RelationshipMap
        nodes={nodes}
        relations={relations}
        affinities={affinities}
        selected={selected}
        theme={theme}
        onSelect={selectPerson}
        onEditRelation={openRelationEditor}
      />

      <div
        style={{
          border: `1px solid ${theme.borderSoft}`,
          borderRadius: 20,
          padding: 15,
          background: theme.panel,
        }}
      >
        <div style={{ fontWeight: 950, fontSize: 15 }}>관계 목록</div>
        <div style={{ display: "grid", gap: 7, marginTop: 11 }}>
          {relationList.length ? (
            relationList.map((relation) => {
              const symmetric =
                SYMMETRIC_RELATIONS.has(relation.relation) || isContextualSymmetricRelationship(relation.relation);
              return (
                <div
                  key={relation.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    flexWrap: "wrap",
                    padding: "9px 12px",
                    borderRadius: 12,
                    border: `1px solid ${theme.borderSoft}`,
                    background: "rgba(255,255,255,0.02)",
                    fontSize: 13,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (relation.subjectRosterId) {
                        selectPerson({ name: relation.subjectName, rosterId: relation.subjectRosterId });
                      }
                    }}
                    style={{
                      border: "none",
                      background: "none",
                      padding: 0,
                      color: theme.text,
                      fontWeight: 900,
                      cursor: relation.subjectRosterId ? "pointer" : "default",
                    }}
                  >
                    {relation.subjectName}
                  </button>
                  <button
                    type="button"
                    onClick={() => openRelationEditor(relation)}
                    style={{
                      padding: "3px 9px",
                      borderRadius: 999,
                      background: symmetric
                        ? "rgba(129,140,248,0.20)"
                        : "rgba(236,72,153,0.20)",
                      border: `1px solid ${symmetric ? "rgba(129,140,248,0.45)" : "rgba(244,114,182,0.45)"}`,
                      color: symmetric ? "#c7d2fe" : "#fbcfe8",
                      fontSize: 11,
                      fontWeight: 900,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                      outline: "none",
                    }}
                    title="클릭해서 관계 변경"
                  >
                    {symmetric ? "↔" : "→"} {relation.relation}
                  </button>
                  {relation.isManual ? (
                    <span
                      style={{
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: "rgba(34,197,94,0.14)",
                        border: "1px solid rgba(74,222,128,0.32)",
                        color: "#bbf7d0",
                        fontSize: 10,
                        fontWeight: 900,
                        whiteSpace: "nowrap",
                      }}
                    >
                      직접 설정
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (relation.objectRosterId) {
                        selectPerson({
                          name: visiblePersonName(relation.objectName),
                          rosterId: relation.objectRosterId,
                        });
                      }
                    }}
                    style={{
                      border: "none",
                      background: "none",
                      padding: 0,
                      color: theme.text,
                      fontWeight: 900,
                      cursor: relation.objectRosterId ? "pointer" : "default",
                    }}
                  >
                    {visiblePersonName(relation.objectName)}
                  </button>
                  {relation.lastSeenTurn > 0 ? (
                    <span style={{ marginLeft: "auto", color: theme.muted, fontSize: 11, fontWeight: 800 }}>
                      {relation.lastSeenTurn}턴
                    </span>
                  ) : null}
                </div>
              );
            })
          ) : !loading ? (
            <div
              style={{
                border: `1px dashed ${theme.borderSoft}`,
                borderRadius: 18,
                padding: 24,
                textAlign: "center",
                color: theme.muted,
                fontSize: 13,
              }}
            >
              아직 이름이 확인된 구조적 관계가 없습니다. 가족·친구·학교·직장 관계가 명확해지면
              자동으로 추가됩니다.
            </div>
          ) : null}
        </div>
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
          등록 인물이 주인공과 <b>직접 대화한 턴</b>에만 ±3 범위로 누적합니다. 아직 직접 대화가
          없으면 «미평가»로 남습니다.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 12 }}>
          {affinities.length ? (
            affinities.map((affinity) => {
              const score = clampScore(affinity.score);
              const evaluated = affinity.lastTurnNo > 0;
              const color = evaluated ? affinityColor(score) : "#64748b";
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
                    opacity: evaluated ? 1 : 0.72,
                    outline: "none",
                    boxShadow: "none",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 950 }}>{affinity.characterName}</span>
                    <span style={{ color, fontWeight: 950, fontSize: evaluated ? 14 : 11 }}>
                      {evaluated ? (
                        <>
                          ♥ {score}
                          {affinity.lastDelta > 0
                            ? ` ↑+${affinity.lastDelta}`
                            : affinity.lastDelta < 0
                              ? ` ↓${affinity.lastDelta}`
                              : " →"}
                        </>
                      ) : (
                        "미평가"
                      )}
                    </span>
                  </div>
                  {evaluated ? (
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
                  ) : null}
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8, fontSize: 11, color: theme.muted }}>
                    <span>{affinity.relationshipLabel}</span>
                    <span>{evaluated ? `${affinity.label} · ${affinity.lastTurnNo}턴` : "직접 대화 없음"}</span>
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
              <div
                style={{
                  color: selectedAffinity.lastTurnNo > 0 ? affinityColor(selectedAffinity.score) : theme.muted,
                  fontWeight: 950,
                  textAlign: "right",
                }}
              >
                <div>{selectedAffinity.relationshipLabel}</div>
                <div style={{ marginTop: 3, fontSize: 12 }}>
                  {selectedAffinity.lastTurnNo > 0
                    ? `♥ ${clampScore(selectedAffinity.score)} · ${selectedAffinity.label}`
                    : "호감도 미평가"}
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
                ["직업", memoryState.character.job],
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
              onClick={() => void loadMemories(selected, memoryState.offset, memoryRequestRef.current)}
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
          인물 노드를 누르면 호감도와 개별 장기기억이 여기에 열립니다.
        </div>
      )}
    </div>
  );
}
