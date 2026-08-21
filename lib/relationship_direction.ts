export type AddressDirection = {
  id?: string;
  speakerKey: string;
  speakerName: string;
  targetKey: string;
  targetName: string;
  term: string;
  sourceRole?: string;
  isManual?: boolean;
  lastSeenTurn?: number;
};

function clean(value: unknown, max = 80) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function key(value: unknown) {
  return clean(value, 120).toLocaleLowerCase("ko-KR");
}

function priority(direction: AddressDirection) {
  if (direction.isManual) return 4;
  if (clean(direction.sourceRole, 20) === "user") return 3;
  if (!clean(direction.sourceRole, 20)) return 2;
  return 1;
}

export function normalizeAddressDirection(value: Partial<AddressDirection>) {
  const direction: AddressDirection = {
    id: clean(value.id, 120),
    speakerKey: clean(value.speakerKey, 120),
    speakerName: clean(value.speakerName, 80),
    targetKey: clean(value.targetKey, 120),
    targetName: clean(value.targetName, 80),
    term: clean(value.term, 40).replace(/^["'“”]+|["'“”]+$/g, ""),
    sourceRole: clean(value.sourceRole, 20),
    isManual: Boolean(value.isManual),
    lastSeenTurn: Math.max(0, Math.trunc(Number(value.lastSeenTurn || 0))),
  };
  if (
    !direction.speakerKey ||
    !direction.speakerName ||
    !direction.targetKey ||
    !direction.targetName ||
    !direction.term ||
    key(direction.speakerKey) === key(direction.targetKey)
  ) {
    return null;
  }
  return direction;
}

export function addressDirectionsConflict(left: AddressDirection, right: AddressDirection) {
  return (
    key(left.term) === key(right.term) &&
    key(left.speakerKey) === key(right.targetKey) &&
    key(left.targetKey) === key(right.speakerKey)
  );
}

export function selectCanonicalAddressDirections(values: Array<Partial<AddressDirection>>) {
  const selected = new Map<string, AddressDirection>();
  for (const value of values) {
    const direction = normalizeAddressDirection(value);
    if (!direction) continue;
    const endpoints = [key(direction.speakerKey), key(direction.targetKey)].sort();
    const conflictKey = `${endpoints[0]}\u0000${endpoints[1]}\u0000${key(direction.term)}`;
    const previous = selected.get(conflictKey);
    if (!previous) {
      selected.set(conflictKey, direction);
      continue;
    }
    const nextRank = [priority(direction), Number(direction.lastSeenTurn || 0)];
    const previousRank = [priority(previous), Number(previous.lastSeenTurn || 0)];
    if (
      nextRank[0] > previousRank[0] ||
      (nextRank[0] === previousRank[0] && nextRank[1] > previousRank[1])
    ) {
      selected.set(conflictKey, direction);
    }
  }
  return Array.from(selected.values());
}

export function formatAddressDirectionGuard(values: Array<Partial<AddressDirection>>) {
  const directions = selectCanonicalAddressDirections(values);
  if (!directions.length) return "";
  return [
    "# [호칭 발화 방향 정사 — 관계 자유문장보다 우선]",
    "- `A → B: 호칭`은 A가 B를 그 호칭으로 부른다는 뜻이다. B가 A를 그렇게 부르는 것이 아니다.",
    "- 호칭은 발화자와 수신자를 뒤집거나 실제 혈연·혼인 관계로 자동 승격하지 않는다.",
    ...directions.map(
      (direction) =>
        `- ${direction.speakerName} → ${direction.targetName}: “${direction.term}” (역방향 사용 금지)`
    ),
  ].join("\n");
}
