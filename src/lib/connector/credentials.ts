import "server-only";
/**
 * Router API passwords are encrypted with AES-256-GCM before they reach the
 * database and decrypted only in the connector sync route, which sends them
 * to the authenticated connector over HTTPS. They are never sent to a browser.
 *
 * Format: v1:<iv base64>:<auth tag base64>:<ciphertext base64>
 * Key: ROUTER_CREDENTIALS_KEY (32 bytes, base64). Rotating the key needs a
 * re-encryption script; key_version is stored with each row for that.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CREDENTIAL_KEY_VERSION = 1;

function key(): Buffer {
  const raw = process.env.ROUTER_CREDENTIALS_KEY ?? "";
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("ROUTER_CREDENTIALS_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).");
  return k;
}

export function credentialKeyConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v${CREDENTIAL_KEY_VERSION}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, ct] = stored.split(":");
  if (v !== `v${CREDENTIAL_KEY_VERSION}` || !iv || !tag || !ct) throw new Error("Unsupported credential format.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
