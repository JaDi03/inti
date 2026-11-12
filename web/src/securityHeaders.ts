/**
 * Fills the page headers (web/security-headers.json) for one deployment: {INTI_API_ORIGIN}
 * becomes the origin of INTI_API_URL, the only API the page may call besides the fixed ones.
 */
export function apiOrigin(apiUrl: string): string {
  const url = new URL(apiUrl);
  // A wildcard or a non-web scheme would open connect-src to more than the one API.
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname.includes("*")) {
    throw new Error(`INTI_API_URL must be one http(s) address with no wildcard: ${apiUrl}`);
  }
  return url.origin;
}

export function securityHeaders(template: Record<string, string>, apiUrl: string): Record<string, string> {
  const origin = apiOrigin(apiUrl);
  return Object.fromEntries(Object.entries(template).map(([name, value]) => [name, value.replaceAll("{INTI_API_ORIGIN}", origin)]));
}
