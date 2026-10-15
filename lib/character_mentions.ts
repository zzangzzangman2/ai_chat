export type CharacterNameIdentity = {
  id: string;
  name: string;
  aliases?: string | string[] | null;
};

export function characterAliases(raw: CharacterNameIdentity["aliases"]): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  const source = String(raw || "").trim();
  if (!source) return [];
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return characterAliases(parsed);
    if (Array.isArray(parsed?.aliases)) return characterAliases(parsed.aliases);
  } catch { /* Legacy comma/newline-separated aliases. */ }
  return source.split(/[\n,;\/|，、]+/u).map((s) => s.trim()).filter(Boolean);
}

function givenName(name: string) {
  if (/^(?:남궁|황보|제갈|선우|독고|서문|사공|동방)[가-힣]{2}$/u.test(name)) return name.slice(2);
  if (/^[김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연방위표명기반왕금옥육인맹제모탁국어은편용][가-힣]{2}$/u.test(name)) return name.slice(1);
  return "";
}

// Inferred short names are lookup-only. Never rewrite a stored canonical name,
// and never guess between people sharing the same given name or explicit alias.
export function findMentionedCharacterIds(rows: CharacterNameIdentity[], text: unknown) {
  const source = String(text || "").replace(/```[\s\S]*?(?:```|$)/gu, " ").toLowerCase();
  const ids = new Set<string>();
  const names = rows.map((row) => ({
    row,
    explicit: [row.name, ...characterAliases(row.aliases).filter((name) => name.length >= 2)].map((n) => n.trim().toLowerCase()).filter(Boolean),
    short: givenName(row.name.trim()),
  }));
  for (const entry of names) {
    if (entry.explicit.some((name) => name.length >= 2
      ? source.includes(name)
      : source.split(/[^\p{L}\p{N}]+/gu).includes(name))) {
      ids.add(entry.row.id);
      continue;
    }
    const short = entry.short;
    if (!short || names.some((other) => other.row.id !== entry.row.id &&
      (other.short === short || other.explicit.includes(short)))) continue;
    // A suffix inside an unrelated word is not a name. Korean particles and
    // vocatives are permitted, including common no-space particle compounds.
    const mention = new RegExp(`(?:^|[^\\p{L}\\p{N}])${short}(?=$|[^\\p{L}\\p{N}]|이랑|에게|한테|하고|랑|(?:은|는|이|가|을|를|와|과|도|만|아|야)(?=$|[^\\p{L}\\p{N}]))`, "u");
    if (mention.test(source)) ids.add(entry.row.id);
  }
  return ids;
}
