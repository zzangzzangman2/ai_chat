export function buildInputPreviewNodes(raw: string): React.ReactNode {
    const text = String(raw ?? "");
    if (!text) return null;

    // 매치: **...** 또는 *...*
    const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
    const parts: { t: string; kind: "n" | "d" }[] = [];
    let last = 0;

    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0;
      if (i > last) parts.push({ t: text.slice(last, i), kind: "d" });
      const seg = m[0];
      const inner = seg.startsWith("**") ? seg.slice(2, -2) : seg.slice(1, -1);
      parts.push({ t: inner, kind: "n" });
      last = i + seg.length;
    }
    if (last < text.length) parts.push({ t: text.slice(last), kind: "d" });

    return (
      <>
        {parts.map((p, idx) => (
          <span
            key={idx}
            style={{
              color: "#ffffff",
              fontWeight: p.kind === "n" ? 400 : 500,
              whiteSpace: "pre-wrap",
            }}
          >
            {p.t}
          </span>
        ))}
      </>
    );
}
