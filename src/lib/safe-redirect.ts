/**
 * Only ever redirect to a path on this site. Anything else (absolute URLs,
 * protocol-relative URLs, backslash tricks) falls back to the default.
 */
export function safeNextPath(next: unknown, fallback = "/app"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
