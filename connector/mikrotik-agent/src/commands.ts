/**
 * The only router changes FibrePulse ever makes: disable or re-enable a PPPoE
 * customer's secret, and drop their active session on disconnect. Requested
 * by the pilot ISP so that suspending a customer cuts their service.
 */
import { RouterOsClient, type Row } from "./routeros.js";

const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export async function runCommand(client: RouterOsClient, type: "disconnect_pppoe" | "reconnect_pppoe", username: string): Promise<string> {
  if (!/^[\w.@:+-]{1,128}$/.test(username)) throw new Error("PPPoE username has characters the connector will not send to a router.");
  const q = encodeURIComponent(username);
  const secrets = list(await client.get(`/ppp/secret?name=${q}`));
  const secret = secrets.find((s) => s.name === username);
  if (!secret?.[".id"]) throw new Error(`PPPoE secret "${username}" was not found on this router.`);
  const id = secret[".id"];

  if (type === "reconnect_pppoe") {
    await client.request("PATCH", `/ppp/secret/${id}`, { disabled: "false" });
    return `PPPoE secret ${username} enabled. The customer can connect again.`;
  }

  await client.request("PATCH", `/ppp/secret/${id}`, { disabled: "true" });
  const active = list(await client.get(`/ppp/active?name=${q}`)).filter((a) => a.name === username && a[".id"]);
  for (const a of active) await client.request("DELETE", `/ppp/active/${a[".id"]}`);
  return `PPPoE secret ${username} disabled${active.length ? ` and ${active.length} active session${active.length === 1 ? "" : "s"} removed` : "; no active session"}.`;
}
