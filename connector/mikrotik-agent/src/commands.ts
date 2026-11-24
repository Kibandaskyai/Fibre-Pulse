/**
 * The only router changes FibrePulse ever makes: disable or re-enable a PPPoE
 * customer's secret, and drop their active session on disconnect. Requested
 * by the pilot ISP so that suspending (or an expired package) cuts service.
 * With RADIUS, only the live session is dropped; see radius.ts.
 *
 * Hotspot (pilot client, 24 Nov 2026): when a code's time ends or the owner
 * cancels it, remove its active hotspot session and its login cookie, so the
 * device cannot slip back in. RADIUS (or the router's Session-Timeout) then
 * refuses the code.
 */
import type { CommandType } from "./cloud.js";
import { RouterOsClient, type Row } from "./routeros.js";

const list = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

export async function runCommand(
  client: RouterOsClient,
  type: CommandType,
  username: string,
  mode: "router_secrets" | "radius" = "router_secrets",
): Promise<string> {
  if (!/^[\w.@:+-]{1,128}$/.test(username)) throw new Error("PPPoE username has characters the connector will not send to a router.");
  const q = encodeURIComponent(username);

  if (type === "disconnect_hotspot") {
    const active = list(await client.get(`/ip/hotspot/active?user=${q}`)).filter((a) => a.user?.toLowerCase() === username.toLowerCase() && a[".id"]);
    for (const a of active) await client.request("DELETE", `/ip/hotspot/active/${a[".id"]}`);
    const cookies = list(await client.get(`/ip/hotspot/cookie?user=${q}`)).filter((c) => c.user?.toLowerCase() === username.toLowerCase() && c[".id"]);
    for (const c of cookies) await client.request("DELETE", `/ip/hotspot/cookie/${c[".id"]}`);
    return active.length
      ? `Removed ${active.length} hotspot session${active.length === 1 ? "" : "s"} for code ${username}.`
      : `Code ${username} was not online.`;
  }

  if (mode === "radius") {
    // RADIUS customers have no secret on the router. RADIUS refuses them
    // while they have no live package, so a disconnect only drops the live
    // session and a reconnect needs nothing: the customer dials in again.
    if (type === "reconnect_pppoe") return `RADIUS will accept ${username} again on the next dial-in. Nothing to change on the router.`;
    const active = list(await client.get(`/ppp/active?name=${q}`)).filter((a) => a.name === username && a[".id"]);
    for (const a of active) await client.request("DELETE", `/ppp/active/${a[".id"]}`);
    return active.length
      ? `Removed ${active.length} active session${active.length === 1 ? "" : "s"} for ${username}; RADIUS refuses the reconnect.`
      : `${username} was not online; RADIUS refuses the next dial-in.`;
  }
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
