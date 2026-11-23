/**
 * Returns a same-site path to send the user to after sign-in, or the fallback.
 * Rejects absolute URLs, protocol-relative URLs (//evil.com) and backslash
 * tricks so the `next` query parameter cannot become an open redirect.
 */
export function safeNextPath(next: unknown, fallback = "/overview"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  try {
    const url = new URL(next, "http://fibrepulse.local");
    if (url.origin !== "http://fibrepulse.local") return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
