export function isChatDebug() {
  return String(process.env.CHAT_DEBUG || "").trim() === "1";
}

export function dbg(obj: any) {
  if (!isChatDebug()) return;
  try {
    console.log(JSON.stringify(obj));
  } catch {
    // ignore
  }
}
