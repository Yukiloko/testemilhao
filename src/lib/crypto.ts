import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/** AES-256-GCM. Output layout: iv(12) | tag(16) | ciphertext. */
export function encrypt(plain: Buffer, keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(payload: Buffer, keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
}

export function hmacSha256Hex(secret: string, body: string | Buffer): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Stable 0..1 value derived from a string; used for deterministic experiment bucketing. */
export function hashToUnit(input: string): number {
  const digest = crypto.createHash("sha256").update(input).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}
