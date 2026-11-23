/**
 * Request signing. Must stay identical to src/lib/connector/signature.ts in
 * the FibrePulse app (a test checks that both produce the same signature).
 */
import { createHash, createHmac } from "node:crypto";

export function canonical(ts: string, nonce: string, method: string, path: string, body: string): string {
  return [ts, nonce, method.toUpperCase(), path, createHash("sha256").update(body).digest("hex")].join("\n");
}

export function sign(token: string, ts: string, nonce: string, method: string, path: string, body: string): string {
  return createHmac("sha256", token).update(canonical(ts, nonce, method, path, body)).digest("hex");
}
