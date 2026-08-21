export type CanonicalFactCandidate = {
  sourceRole: "user" | "assistant";
  value: string;
  turnNo: number;
};

function normalizedValue(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/\s+/g, "")
    .trim();
}

export function resolveCanonicalFactCandidate<T extends CanonicalFactCandidate>(facts: T[]): T | null {
  const userFacts = facts.filter((fact) => fact.sourceRole === "user");
  if (userFacts.length) return userFacts[userFacts.length - 1];

  const groups = new Map<string, T[]>();
  for (const fact of facts.filter((item) => item.sourceRole === "assistant")) {
    const key = normalizedValue(fact.value);
    if (!key) continue;
    const list = groups.get(key) || [];
    list.push(fact);
    groups.set(key, list);
  }

  const corroborated = Array.from(groups.values())
    .map((items) => ({
      items,
      distinctTurns: new Set(items.map((item) => Math.max(0, Math.trunc(Number(item.turnNo) || 0)))).size,
    }))
    .filter((group) => group.distinctTurns >= 2)
    .sort(
      (a, b) =>
        b.distinctTurns - a.distinctTurns ||
        Math.min(...a.items.map((item) => item.turnNo)) - Math.min(...b.items.map((item) => item.turnNo))
    );

  if (!corroborated.length) return null;
  return corroborated[0].items[0] || null;
}
