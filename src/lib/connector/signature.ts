/**
 * Request signing between the FibrePulse Connector Agent and the cloud.
 * The agent sends its token as a Bearer token over HTTPS and signs every
 * request with HMAC-SHA256 keyed by that token:
 *
 *   canonical = timestamp \n nonce \n METHOD \n /path \n sha256(body)
 *   X-FibrePulse-Signature = hex(HMAC-SHA256(token, canonical))
 *
 * The database checks the token hash, the timestamp window, the nonce
 * (replay) and the rate limit. The same code lives in
 * connector/mikrotik-agent/src/signature.ts: keep them identical.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const HEADER_TIMESTAMP = "x-fibrepulse-timestamp";
export const HEADER_NONCE = "x-fibrepulse-nonce";
export const HEADER_SIGNATURE = "x-fibrepulse-signature";
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function canonical(ts: string, nonce: string, method: string, path: string, body: string): string {
  return [ts, nonce, method.toUpperCase(), path, createHash("sha256").update(body).digest("hex")].join("\n");
}

export function sign(token: string, ts: string, nonce: string, method: string, path: string, body: string): string {
  return createHmac("sha256", token).update(canonical(ts, nonce, method, path, body)).digest("hex");
}

export function verifySignature(token: string, signature: string, ts: string, nonce: string, method: string, path: string, body: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(token, ts, nonce, method, path, body), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
