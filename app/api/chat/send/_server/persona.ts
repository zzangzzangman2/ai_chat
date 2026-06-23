export type PersonaOverride = {
  personaName?: string;
  personaAge?: number;
  personaGender?: string;
  personaInfo?: string;
} | null;

export function resolvePersona(settings: any, personaOverride: PersonaOverride) {
  const ov = personaOverride && typeof personaOverride === "object" ? personaOverride : null;

  const name = String(settings?.personaName || "").trim() || String(ov?.personaName || "").trim();
  const age = Number(settings?.personaAge || 0) || Number(ov?.personaAge || 0) || 0;
  const gender = String(settings?.personaGender || "").trim() || String(ov?.personaGender || "").trim();
  const info = String(settings?.personaInfo || "").trim() || String(ov?.personaInfo || "").trim();

  return { name, age, gender, info };
}

export function persistPersonaIfMissing(db: any, chatId: string, settings: any, persona: { name: string; age: number; gender: string; info: string }) {
  if (!persona.name) return;
  if (String(settings?.personaName || "").trim()) return;

  try {
    db.prepare(
      `UPDATE chat_settings SET personaName=?, personaAge=?, personaGender=?, personaInfo=?, updatedAt=? WHERE chatId=?`
    ).run(persona.name, persona.age || 0, persona.gender, persona.info, Date.now(), chatId);
    settings.personaName = persona.name;
    settings.personaAge = persona.age || 0;
    settings.personaGender = persona.gender;
    settings.personaInfo = persona.info;
  } catch {
    // ignore
  }
}
