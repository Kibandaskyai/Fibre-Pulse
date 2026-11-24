/**
 * The MikroTik hotspot sends buyers to the FibrePulse WiFi page with its own
 * login address (link-login-only), e.g. http://10.5.50.1/login. The page then
 * posts the access code back to that address. To stop the page being used to
 * post codes anywhere else, only addresses on a private network (or a single
 * name like "hotspot.local") are accepted.
 */
export function safeHotspotLoginUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    const parts = ip.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return null;
    const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    return isPrivate ? u.toString() : null;
  }
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return u.toString();
  return null;
}

/** MikroTik sends the device MAC as "AA:BB:CC:DD:EE:FF"; keep only a valid one. */
export function cleanMac(raw: string | null | undefined): string | null {
  const hex = String(raw ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex.match(/../g)!.join(":") : null;
}
