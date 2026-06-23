import crypto from "crypto";

// 메시지/메모리를 DB에 저장할 때 암호화 옵션
// - CHAT_DB_ENC_KEY: base64 인코딩된 32바이트 키 (AES-256-GCM)
//   예) node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

const PREFIX = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.CHAT_DB_ENC_KEY || "";
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) return null;
    return key;
  } catch {
    return null;
  }
}

export function encryptIfPossible(plain: string): string {
  const key = getKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // payload = iv + tag + ciphertext
  const payload = Buffer.concat([iv, tag, enc]).toString("base64");
  return `${PREFIX}${payload}`;
}

export function decryptIfPossible(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = getKey();
  if (!key) return stored; // 키가 없으면 복호화 불가: 그대로
  try {
    const payload = Buffer.from(stored.slice(PREFIX.length), "base64");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const data = payload.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return plain;
  } catch {
    return "";
  }
}
