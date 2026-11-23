import { NextResponse, type NextRequest } from "next/server";
import { decryptSecret } from "@/lib/connector/credentials";
import { connectorDb, dbFailure, readConnectorRequest } from "@/lib/connector/handler";

/**
 * Connector heartbeat. Returns the routers this connector polls (with their
 * API password decrypted for the connector only) and any queued router
 * commands. Called every ~15 seconds.
 */
export async function POST(request: NextRequest) {
  const req = await readConnectorRequest(request);
  if (req instanceof NextResponse) return req;
  const version = typeof (req.body as { version?: unknown }).version === "string" ? String((req.body as { version: string }).version).slice(0, 40) : null;
  const { data, error } = await connectorDb().rpc("connector_sync", { p_token: req.token, p_nonce: req.nonce, p_ts: req.ts, p_version: version });
  if (error) return dbFailure(error);

  const config = data as { routers: { secret: string | null; key_version: number | null; [k: string]: unknown }[]; [k: string]: unknown };
  const routers = config.routers.map(({ secret, key_version, ...r }) => {
    void key_version;
    let password: string | null = null;
    let credentialError: string | null = null;
    if (secret) {
      try {
        password = decryptSecret(secret);
      } catch {
        credentialError = "Stored password could not be decrypted. Enter it again in FibrePulse.";
      }
    }
    return { ...r, password, credential_error: credentialError };
  });
  return NextResponse.json({ ...config, routers }, { headers: { "cache-control": "no-store" } });
}
