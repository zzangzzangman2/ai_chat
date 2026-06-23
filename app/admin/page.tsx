'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';

type AdminUserRow = {
  email: string;
  nickname: string;
  role: 'user' | 'admin' | string;
  createdAt: string;
  lastSeenAt: string;
  isBanned: boolean;
  balance: number;
  spentTotal: number;
};

function fmtIso(iso: string) {
  if (!iso) return '-';
  // server stores either sqlite datetime('now') or ISO; normalize display
  try {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toLocaleString();
  } catch {}
  return iso;
}

function fmtFriendFee(v: number) {
  const n = Math.round(v || 0);
  return n.toLocaleString();
}

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [q, setQ] = useState('');
  const [giftAmount, setGiftAmount] = useState<Record<string, string>>({});

  // ---- 배너 관리 ----
  type BannerRow = { id: number; imageUrl: string; linkUrl: string; isActive: 0 | 1; sortOrder: number; createdAt: number };
  const [banners, setBanners] = useState<BannerRow[]>([]);
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerDirty, setBannerDirty] = useState(false); // draft changed but not published
  const [bannerApplyBusy, setBannerApplyBusy] = useState(false);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [bannerPreviewUrl, setBannerPreviewUrl] = useState<string>('');
  const [bannerLink, setBannerLink] = useState('');
  const [bannerActive, setBannerActive] = useState(true);
  const [bannerOrder, setBannerOrder] = useState('0');

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return rows;
    return rows.filter((r) =>
      r.email.toLowerCase().includes(qq) || (r.nickname || '').toLowerCase().includes(qq)
    );
  }, [q, rows]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users', { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setError(res.status === 403 ? '관리자만 접근 가능합니다.' : '목록을 불러오지 못했습니다.');
        setRows([]);
      } else {
        // 추방된 사용자는 목록에서 숨김 (API에서도 기본적으로 제외되지만, UI에서도 안전망)
        const arr = Array.isArray(j.users) ? (j.users as AdminUserRow[]) : [];
        setRows(arr.filter((u) => !u?.isBanned));
      }
    } catch (e: any) {
      setError('네트워크 오류');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);


  const refreshBanners = useCallback(async () => {
    setBannerBusy(true);
    try {
      const res = await fetch('/api/admin/banners', { cache: 'no-store' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setBanners([]);
        return;
      }
      setBanners(Array.isArray(j.banners) ? j.banners : []);
    } finally {
      setBannerBusy(false);
    }
  }, []);

  const applyBanners = useCallback(async () => {
    setBannerApplyBusy(true);
    try {
      const res = await fetch('/api/admin/banners/apply', { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        alert('적용 실패');
        return;
      }
      setBannerDirty(false);
      alert('배너가 적용되었습니다. (메인에서 10~15초 내 반영)');
    } finally {
      setBannerApplyBusy(false);
    }
  }, []);

  useEffect(() => {
    refreshBanners();
  }, [refreshBanners]);

  useEffect(() => {
    if (!bannerFile) {
      if (bannerPreviewUrl) URL.revokeObjectURL(bannerPreviewUrl);
      setBannerPreviewUrl('');
      return;
    }
    const u = URL.createObjectURL(bannerFile);
    setBannerPreviewUrl(u);
    return () => {
      URL.revokeObjectURL(u);
    };
  }, [bannerFile]);

  const uploadBanner = useCallback(async () => {
    if (!bannerFile) {
      alert('배너 이미지를 선택하세요');
      return;
    }
    setBannerBusy(true);
    try {
      // 1) 업로드 → imageUrl 확보
      const fd = new FormData();
      fd.append('file', bannerFile);
      fd.append('linkUrl', bannerLink.trim());
      const up = await fetch('/api/admin/banners/upload', { method: 'POST', body: fd });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok || !uj?.ok || !uj?.imageUrl) {
        alert('업로드 실패');
        return;
      }

      // 2) DB 등록
      const create = await fetch('/api/admin/banners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: String(uj.imageUrl),
          linkUrl: bannerLink.trim(),
          isActive: bannerActive ? 1 : 0,
          sortOrder: Number(bannerOrder || 0) || 0,
        }),
      });
      const cj = await create.json().catch(() => ({}));
      if (!create.ok || !cj?.ok) {
        alert('등록 실패');
        return;
      }

      setBannerFile(null);
      setBannerLink('');
      setBannerOrder('0');
      setBannerActive(true);
      await refreshBanners();
      setBannerDirty(true);
    } finally {
      setBannerBusy(false);
    }
  }, [bannerActive, bannerFile, bannerLink, bannerOrder, refreshBanners]);

  const toggleBannerActive = useCallback(
    async (id: number, next: boolean) => {
      const res = await fetch('/api/admin/banners', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, isActive: next ? 1 : 0 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        alert('변경 실패');
        return;
      }
      await refreshBanners();
      setBannerDirty(true);
    },
    [refreshBanners]
  );

  const deleteBanner = useCallback(
    async (id: number) => {
      if (!confirm('배너를 삭제할까요?')) return;
      const res = await fetch(`/api/admin/banners?id=${id}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        alert('삭제 실패');
        return;
      }
      await refreshBanners();
      setBannerDirty(true);
    },
    [refreshBanners]
  );


  useEffect(() => {
    refresh();
  }, [refresh]);

  const setRole = useCallback(async (email: string, role: 'user' | 'admin') => {
    const res = await fetch('/api/admin/users/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      alert('권한 변경 실패');
      return;
    }
    await refresh();
  }, [refresh]);

  const gift = useCallback(async (email: string) => {
    const raw = (giftAmount[email] ?? '').trim();
    const amount = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('선물할 친구비(양수)를 입력하세요');
      return;
    }
    const res = await fetch('/api/admin/users/gift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      alert('선물 실패');
      return;
    }
    setGiftAmount((m) => ({ ...m, [email]: '' }));
    await refresh();
  }, [giftAmount, refresh]);

  const deduct = useCallback(async (email: string) => {
    const raw = (giftAmount[email] ?? '').trim();
    const amount = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('차감할 친구비(양수)를 입력하세요');
      return;
    }
    const res = await fetch('/api/admin/users/gift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, amount, mode: 'deduct' }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      alert(j?.error === 'insufficient' ? '잔액이 부족합니다' : '차감 실패');
      return;
    }
    setGiftAmount((m) => ({ ...m, [email]: '' }));
    await refresh();
  }, [giftAmount, refresh]);

  const kick = useCallback(async (email: string) => {
    const ok = confirm('정말 탈퇴(추방) 시키겠습니까?');
    if (!ok) return;
    const res = await fetch('/api/admin/users/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      alert('추방 실패');
      return;
    }
    await refresh();
  }, [refresh]);

  return (
    <div style={{ minHeight: '100vh', background: '#0b0b0b', color: '#fff', padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>관리자 페이지</div>
          <div style={{ opacity: 0.7, marginTop: 4, fontSize: 13 }}>
            계정 권한 / 친구비 / 추방 관리
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="메일/닉네임 검색"
            style={{
              width: 260,
              height: 36,
              padding: '0 12px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'rgba(255,255,255,0.06)',
              color: '#fff',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => refresh()}
            style={{
              height: 36,
              padding: '0 12px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            새로고침
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, border: '1px solid rgba(255,255,255,0.10)', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            (1) 메일 (2) 닉네임 (3) 계정유형 (4) 가입일자 (5) 최근접속 (6) 현재친구비 (7) 사용총량 (8) 선물 (9) 추방
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 16, opacity: 0.8 }}>불러오는 중…</div>
        ) : error ? (
          <div style={{ padding: 16, color: '#ffb4b4' }}>{error}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', background: 'rgba(255,255,255,0.03)' }}>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>메일</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>닉네임</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>계정유형</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>가입일자</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>최근접속</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>현재 친구비</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>사용 총량</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>친구비 선물</th>
                  <th style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>추방</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.email} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{r.email}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{r.nickname || '-'}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <select
                        value={r.role === 'admin' ? 'admin' : 'user'}
                        onChange={(e) => setRole(r.email, e.target.value as any)}
                        disabled={r.isBanned}
                        style={{
                          height: 32,
                          borderRadius: 10,
                          border: '1px solid rgba(255,255,255,0.18)',
                          background: 'rgba(255,255,255,0.06)',
                          color: '#fff',
                          colorScheme: 'dark',
                          padding: '0 10px',
                          outline: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="user" style={{ background: '#0b0b0b', color: '#fff' }}>일반</option>
                        <option value="admin" style={{ background: '#0b0b0b', color: '#fff' }}>관리자</option>
                      </select>
                      {r.isBanned && (
                        <span style={{ marginLeft: 8, color: '#ffb4b4', fontWeight: 700 }}>추방됨</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', opacity: 0.9 }}>{fmtIso(r.createdAt)}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', opacity: 0.9 }}>{fmtIso(r.lastSeenAt)}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontWeight: 800 }}>{fmtFriendFee(r.balance)}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{fmtFriendFee(r.spentTotal)}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          value={giftAmount[r.email] ?? ''}
                          onChange={(e) => setGiftAmount((m) => ({ ...m, [r.email]: e.target.value }))}
                          placeholder="예: 5000"
                          disabled={r.isBanned}
                          style={{
                            width: 110,
                            height: 32,
                            padding: '0 10px',
                            borderRadius: 10,
                            border: '1px solid rgba(255,255,255,0.18)',
                            background: 'rgba(255,255,255,0.06)',
                            color: '#fff',
                            outline: 'none',
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => gift(r.email)}
                          disabled={r.isBanned}
                          style={{
                            height: 32,
                            padding: '0 10px',
                            borderRadius: 10,
                            border: '1px solid rgba(255,255,255,0.18)',
                            background: 'rgba(255,255,255,0.08)',
                            color: '#fff',
                            cursor: r.isBanned ? 'not-allowed' : 'pointer',
                            fontWeight: 800,
                          }}
                        >
                          선물
                        </button>

                        <button
                          type="button"
                          onClick={() => deduct(r.email)}
                          disabled={r.isBanned}
                          style={{
                            height: 32,
                            padding: '0 10px',
                            borderRadius: 10,
                            border: '1px solid rgba(255,120,120,0.35)',
                            background: 'rgba(255,120,120,0.10)',
                            color: '#ffd2d2',
                            cursor: r.isBanned ? 'not-allowed' : 'pointer',
                            fontWeight: 900,
                          }}
                        >
                          차감
                        </button>
                      </div>
                      <div style={{ opacity: 0.55, marginTop: 4, fontSize: 11 }}>
                        선물(+) / 차감(-) — 관리자 잔액은 차감되지 않습니다
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <button
                        type="button"
                        onClick={() => kick(r.email)}
                        disabled={r.isBanned || r.role === 'admin'}
                        style={{
                          height: 32,
                          padding: '0 10px',
                          borderRadius: 10,
                          border: '1px solid rgba(255,120,120,0.35)',
                          background: 'rgba(255,120,120,0.10)',
                          color: '#ffd2d2',
                          cursor: r.isBanned || r.role === 'admin' ? 'not-allowed' : 'pointer',
                          fontWeight: 800,
                        }}
                      >
                        추방
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      
      {/* ---------------- 배너 관리 ---------------- */}
      <div style={{ marginTop: 24, padding: 16, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, background: 'rgba(255,255,255,0.03)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>배너 관리</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {bannerDirty && (
              <div style={{ fontSize: 12, opacity: 0.8, color: '#ffe6a6', fontWeight: 800 }}>
                미적용 변경 있음
              </div>
            )}
            <button
              onClick={applyBanners}
              disabled={!bannerDirty || bannerApplyBusy || bannerBusy}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.14)',
                background: !bannerDirty ? 'rgba(0,0,0,0.25)' : 'rgba(124, 92, 255, 0.95)',
                color: '#fff',
                fontWeight: 900,
                cursor: !bannerDirty || bannerApplyBusy || bannerBusy ? 'not-allowed' : 'pointer',
              }}
            >
              {bannerApplyBusy ? '적용중...' : '적용(확인)'}
            </button>
            <button
              onClick={refreshBanners}
              disabled={bannerBusy}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(0,0,0,0.25)',
                color: '#fff',
                fontWeight: 800,
                cursor: bannerBusy ? 'not-allowed' : 'pointer',
              }}
            >
              새로고침
            </button>
          </div>
        </div>

        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ padding: 12, borderRadius: 12, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>배너 등록</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {bannerPreviewUrl && (
                <div style={{ width: '100%', height: 96, borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={bannerPreviewUrl} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                </div>
              )}
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setBannerFile(e.target.files?.[0] || null)}
                style={{
                  width: '100%',
                  padding: 10,
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(0,0,0,0.35)',
                  color: '#fff',
                }}
              />
              <input
                value={bannerLink}
                onChange={(e) => setBannerLink(e.target.value)}
                placeholder="클릭 링크 URL (선택)"
                style={{
                  width: '100%',
                  padding: 10,
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(0,0,0,0.35)',
                  color: '#fff',
                }}
              />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={bannerActive} onChange={(e) => setBannerActive(e.target.checked)} />
                  <span style={{ fontWeight: 700, opacity: 0.9 }}>활성</span>
                </label>
                <input
                  value={bannerOrder}
                  onChange={(e) => setBannerOrder(e.target.value)}
                  placeholder="정렬(숫자, 낮을수록 먼저)"
                  style={{
                    flex: 1,
                    padding: 10,
                    borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: 'rgba(0,0,0,0.35)',
                    color: '#fff',
                  }}
                />
                <button
                  onClick={uploadBanner}
                  disabled={bannerBusy}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 10,
                    border: 'none',
                    background: 'rgba(124, 92, 255, 0.95)',
                    color: '#fff',
                    fontWeight: 900,
                    cursor: bannerBusy ? 'not-allowed' : 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  등록
                </button>
              </div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>
                * 이미지 업로드는 1차 지원(서버 public/uploads/banners 저장). 2차에서 업로드 파일 관리/정리까지 확장 가능.
              </div>
            </div>
          </div>

          <div style={{ padding: 12, borderRadius: 12, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>등록된 배너 ({banners.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 260, overflow: 'auto', paddingRight: 6 }}>
              {banners.length === 0 ? (
                <div style={{ opacity: 0.6, padding: 10 }}>등록된 배너가 없습니다.</div>
              ) : (
                banners.map((b) => (
                  <div key={b.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}>
                    <div style={{ width: 120, height: 54, borderRadius: 10, overflow: 'hidden', background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={b.imageUrl ? `${b.imageUrl}${b.imageUrl.includes('?') ? "&" : "?"}v=${b.id}` : b.imageUrl} alt="banner" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontWeight: 900 }}>#{b.id}</span>
                        <span style={{ fontSize: 12, opacity: 0.7 }}>order {b.sortOrder}</span>
                        <span style={{ fontSize: 12, opacity: b.isActive ? 0.9 : 0.55, color: b.isActive ? '#bfffd2' : '#ffd2d2' }}>
                          {b.isActive ? 'ACTIVE' : 'OFF'}
                        </span>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.linkUrl || '(링크 없음)'}</div>
                    </div>
                    <button
                      onClick={() => toggleBannerActive(b.id, !b.isActive)}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 10,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(0,0,0,0.25)',
                        color: '#fff',
                        fontWeight: 800,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {b.isActive ? '비활성' : '활성'}
                    </button>
                    <button
                      onClick={() => deleteBanner(b.id)}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 10,
                        border: '1px solid rgba(255,255,255,0.14)',
                        background: 'rgba(160, 40, 40, 0.25)',
                        color: '#ffd2d2',
                        fontWeight: 900,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      삭제
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>


<div style={{ marginTop: 14, opacity: 0.6, fontSize: 12 }}>
        접속/닉네임 기록이 비어있으면, 사용자가 한 번이라도 접속해야 표시됩니다.
      </div>
    </div>
  );
}