import "server-only";
/**
 * Shared request handling for /api/connector/v1/*: size limit, signature
 * check, and a Supabase client with the public key and no user session (the
 * database functions authenticate the connector token themselves). No
 * service role key is used anywhere in the connector path.
 */
import { createClient as createSupabase } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { publicEnv } from "@/lib/env";
import { HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, MAX_BODY_BYTES, verifySignature } from "./signature";

export type ConnectorRequest = { token: string; nonce: string; ts: string; body: unknown };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function readConnectorRequest(request: NextRequest): Promise<ConnectorRequest | NextResponse> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const ts = request.headers.get(HEADER_TIMESTAMP) ?? "";
  const nonce = request.headers.get(HEADER_NONCE) ?? "";
  const signature = request.headers.get(HEADER_SIGNATURE) ?? "";
  if (!/^fpc_[A-Za-z0-9]{32,100}$/.test(token) || !ts || !nonce || !signature) return fail(401, "Missing or malformed connector credentials.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return fail(413, "Request body too large.");
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return fail(413, "Request body too large.");
  if (!verifySignature(token, signature, ts, nonce, request.method, request.nextUrl.pathname, text)) return fail(401, "Signature does not match.");
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "Body is not valid JSON.");
    }
  }
  return { token, nonce, ts, body };
}

export function connectorDb() {
  const env = publicEnv();
  return createSupabase(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Map database errors to HTTP without leaking internals. */
export function dbFailure(error: { code?: string; message?: string }) {
  const status = error.code === "28000" ? 401 : error.code === "54000" ? 429 : error.code === "P0002" ? 404 : error.code === "23514" ? 400 : 500;
  const message = status === 500 ? "Server error. The connector will retry." : (error.message ?? "Refused.");
  return fail(status, message);
}
