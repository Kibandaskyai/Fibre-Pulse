import { NextResponse, type NextRequest } from "next/server";
import { connectorDb, dbFailure, readConnectorRequest } from "@/lib/connector/handler";

/** Router telemetry from the connector (system health, interfaces, sessions). */
export async function POST(request: NextRequest) {
  const req = await readConnectorRequest(request);
  if (req instanceof NextResponse) return req;
  const body = req.body as { routers?: unknown };
  if (!body || !Array.isArray(body.routers)) return NextResponse.json({ error: "Body must have a routers list." }, { status: 400 });
  const { data, error } = await connectorDb().rpc("connector_ingest", { p_token: req.token, p_nonce: req.nonce, p_ts: req.ts, p_payload: body });
  if (error) return dbFailure(error);
  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}
