import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiOrigin, securityHeaders } from "./securityHeaders";

const template = JSON.parse(readFileSync(new URL("../security-headers.json", import.meta.url), "utf8")) as Record<string, string>;

describe("securityHeaders", () => {
  it("lets the page call exactly the configured API origin", () => {
    const csp = securityHeaders(template, "https://api.example.com/v1?x=1")["Content-Security-Policy"];
    expect(csp).toContain(" https://api.example.com;");
    expect(csp).not.toContain("{INTI_API_ORIGIN}");
  });

  it("refuses a wildcard, a non-web scheme or text that is not a URL", () => {
    expect(() => apiOrigin("https://*.example.com")).toThrow(/no wildcard/);
    expect(() => apiOrigin("javascript:alert(1)")).toThrow(/no wildcard/);
    expect(() => apiOrigin("data:text/plain,x")).toThrow(/no wildcard/);
    expect(() => apiOrigin("https://a.com; script-src *")).toThrow();
  });

  it("accepts a local address for development", () => {
    expect(apiOrigin("http://localhost:8787")).toBe("http://localhost:8787");
  });
});
