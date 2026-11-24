import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { connectorDb, dbFailure, readConnectorRequest } from "@/lib/connector/handler";

const resultSchema = z.object({ command_id: z.uuid(), success: z.boolean(), message: z.string().max(300).optional() });

/** The outcome of a router command (disconnect or reconnect). */
export async function POST(request: NextRequest) {
  const req = await readConnectorRequest(request);
  if (req instanceof NextResponse) return req;
  const parsed = resultSchema.safeParse(req.body);
  if (!parsed.success) return NextResponse.json({ error: "Body must have command_id, success and message." }, { status: 400 });
  const { error } = await connectorDb().rpc("connector_command_result", {
    p_token: req.token, p_nonce: req.nonce, p_ts: req.ts,
    p_command: parsed.data.command_id, p_success: parsed.data.success, p_message: parsed.data.message ?? null,
  });
  if (error) return dbFailure(error);
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
