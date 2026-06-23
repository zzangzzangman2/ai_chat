// Weighted distribution helper.
// Converts a total integer into per-key integers proportional to weights,
// keeping the final sum exactly equal to total.

export function distribute(total: number, weights: Record<string, number>) {
  const entries = Object.entries(weights)
    .map(([k, w]) => [k, Math.max(0, Number(w) || 0)] as const)
    .filter(([, w]) => w > 0);
  const sumW = entries.reduce((a, [, w]) => a + w, 0);
  if (!Number.isFinite(total) || total <= 0 || sumW <= 0) {
    return Object.fromEntries(Object.keys(weights).map((k) => [k, 0]));
  }
  // floor 배분 후, 나머지를 소수점 큰 순서로 분배
  const raw = entries.map(([k, w]) => ({ k, w, exact: (total * w) / sumW }));
  const base = raw.map((r) => ({ ...r, n: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
  let used = base.reduce((a, r) => a + r.n, 0);
  let remain = total - used;
  base.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < base.length && remain > 0; i++) {
    base[i].n += 1;
    remain -= 1;
  }
  const out: Record<string, number> = Object.fromEntries(Object.keys(weights).map((k) => [k, 0]));
  for (const r of base) out[r.k] = r.n;
  // 만약 remain이 남는 특이 케이스(가중치 동일 등)도 안전 처리
  if (remain > 0) {
    const keys = base.map((r) => r.k);
    for (let i = 0; i < remain; i++) out[keys[i % keys.length]] += 1;
  }
  return out;
}
