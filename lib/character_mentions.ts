export type CharacterNameIdentity = {
  id: string;
  name: string;
  aliases?: string | string[] | null;
};

// Korean particles may be attached without whitespace. An unrelated word or
// the tail of a longer name is not a mention (청아한, 제갈청아 != 청아).
export function characterNameLiteralPattern(name: string) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Titles are often written with a space in narration but stored without one.
  // Keep the boundary: 영안 공주 must not match another person's longer name.
  const titled = /^(.{2,}?)\s*(공주|옹주|왕자|황자|대군)$/u.exec(name.trim());
  return titled ? `${escape(titled[1].trim())}\\s*${escape(titled[2])}` : escape(name);
}

export function characterNamePattern(name: string) {
  const escaped = characterNameLiteralPattern(name);
  return `(?<![\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_]|에게|한테|께서|께|이랑|이야|처럼|하고|보다|라고|예요|입니다|입니까|까지|부터|더러|쪽|랑|의|은|는|을|를|와|과|도|만|아|야|이|가|님|씨|양|군)`;
}

export function mentionsCharacterName(text: unknown, name: string) {
  const source = String(text || ""), cleanName = name.trim();
  if (!cleanName || !source.toLowerCase().replace(/\s/g, "").includes(cleanName.toLowerCase().replace(/\s/g, ""))) return false;
  return new RegExp(characterNamePattern(cleanName), "iu").test(source);
}

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
  // A title is not a short personal name (e.g. 안공주 -> 공주).
  if (/(?:공주|옹주|왕자|황자|대군)$/u.test(name)) return "";
  if (/^(?:남궁|황보|제갈|선우|독고|서문|사공|동방)[가-힣]{2}$/u.test(name)) return name.slice(2);
  if (/^[김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민진지엄채원천방공현함변염여추도소석선설마길연방위표명기반왕금옥육인맹제모탁국어은편용][가-힣]{2}$/u.test(name)) return name.slice(1);
  return "";
}

/** A vocative is stronger evidence than a topic mention. Only registered or
 * unambiguous short names qualify, including informal no-space user typing. */
export function findAddressedCharacterIds(rows: CharacterNameIdentity[], text: unknown) {
  const source = String(text || "").replace(/```[\s\S]*?(?:```|$)/gu, " ");
  const variants = rows.map(row => ({row, names:[row.name, ...characterAliases(row.aliases), givenName(row.name)]
    .map(name => name.trim()).filter(name => name.length >= 2)}));
  const result = new Set<string>();
  for (const entry of variants) {
    for (const name of entry.names) {
      // A full registered name takes precedence over somebody else's short alias.
      const canonical = rows.find(row => row.name === name);
      if (canonical ? canonical.id !== entry.row.id : variants.some(other => other.row.id !== entry.row.id && other.names.includes(name))) continue;
      const escaped = characterNameLiteralPattern(name);
      const vocative = new RegExp(`(?<![\\p{L}\\p{N}_])(?:(?:으|어|아|야|오)[,\\s]*)?${escaped}(?:아|야)(?!말로)|(?:^|[\\s,.!?*])(?:야|저기|있잖아)[,\\s]+${characterNamePattern(name)}|${characterNamePattern(name)}\\s*[,，]|^\\s*\\*?${escaped}[.!?~…]*\\*?\\s*$`, "iu");
      const directed = new RegExp(`${characterNamePattern(name)}(?:에게|한테|께)(?:만)?\\s*[^.!?\\n]{0,24}(?:묻는다|물었다|물어본|질문한|질문하|말한다|말을\\s*건|부탁한|부탁하|인사)|${characterNamePattern(name)}(?:은|는|이|가|도|만)?\\s*(?:어떻게\\s*생각해|말해|대답해|설명해|알려줘|읽어줘|이리\\s*와|와서)`, "iu");
      if (vocative.test(source) || directed.test(source)) { result.add(entry.row.id); break; }
    }
  }
  return result;
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
      ? mentionsCharacterName(source, name)
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
