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
  const body = req.body as { version?: unknown; radius_version?: unknown };
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  // The RADIUS list (PPPoE customers and hotspot codes) is only sent when it
  // changed since the version the connector already holds.
  const radiusVersion = typeof body.radius_version === "string" ? body.radius_version.slice(0, 64) : null;
  const { data, error } = await connectorDb().rpc("connector_sync", {
    p_token: req.token,
    p_nonce: req.nonce,
    p_ts: req.ts,
    p_version: version,
    p_radius_version: radiusVersion,
  });
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
