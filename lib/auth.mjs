import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hashHex] = String(stored || "").split(":");
  if (!salt || !hashHex) return false;
  const derived = await scrypt(password, salt, KEY_LENGTH);
  const stored_ = Buffer.from(hashHex, "hex");
  if (derived.length !== stored_.length) return false;
  return timingSafeEqual(derived, stored_);
}

// Sessions are a signed token (userId.expiry.signature), stored client-side
// in an HttpOnly cookie. No server-side session table needed to log a user
// in/out or check "who is this". The token is *not* revocable before it
// expires (7 days) — acceptable for a small B2B site; note this in any
// security review before scaling up.
export function createSessionToken(userId, secret, ttlMs = 7 * 24 * 60 * 60 * 1000) {
  const expires = Date.now() + ttlMs;
  const payload = `${userId}.${expires}`;
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

export function verifySessionToken(token, secret) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, signature] = parts;
  const payload = `${userId}.${expires}`;
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expires)) return null;
  return userId;
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}
