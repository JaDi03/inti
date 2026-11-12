// Prints the Caddyfile for a server that hosts Inti: the web app on its own domain with the
// headers from web/security-headers.json, and the agent API behind a reverse proxy.
// Every domain comes from the .env file, so the same script serves any deployment.
// Usage: node scripts/caddyfile.mjs [path/to/.env] > Caddyfile
import { readFileSync } from "node:fs";

const envPath = process.argv[2] ?? ".env";
process.loadEnvFile(envPath);

// The web and the API must be public https origins; any other value stops the script.
function httpsHost(name, value) {
  if (!value) throw new Error(`${name} is missing from ${envPath}`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value.replace(/\/$/, "")) {
    throw new Error(`${name} must be an https origin like https://example.com, got ${value}`);
  }
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) throw new Error(`${name} has an unexpected host: ${url.hostname}`);
  return url;
}

// The first allowed origin is the web app's own address.
const webUrl = httpsHost("SERVER_ALLOWED_ORIGINS", (process.env.SERVER_ALLOWED_ORIGINS ?? "").split(",")[0]?.trim());
const apiUrl = httpsHost("INTI_API_URL", process.env.INTI_API_URL);
const port = Number(process.env.SERVER_PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SERVER_PORT must be a port number");
if ((process.env.SERVER_HOST || "127.0.0.1") !== "127.0.0.1") {
  throw new Error("SERVER_HOST must be 127.0.0.1: only the proxy reaches the agent API");
}
if (process.env.SERVER_TRUSTED_PROXY !== "127.0.0.1") {
  throw new Error("SERVER_TRUSTED_PROXY must be 127.0.0.1 behind this proxy, so rate limits see the real client address");
}

const headers = JSON.parse(readFileSync(new URL("../web/security-headers.json", import.meta.url), "utf8"));
const headerLines = Object.entries(headers).map(([name, value]) => {
  const rendered = value.replaceAll("{INTI_API_ORIGIN}", apiUrl.origin);
  if (rendered.includes('"')) throw new Error(`header ${name} contains a double quote`);
  return `\t\t${name} "${rendered}"`;
});

const blocks = [
  `${webUrl.hostname} {
\troot * /var/www/inti
\ttry_files {path} /index.html
\tencode zstd gzip
\theader {
${headerLines.join("\n")}
\t\t-Server
\t}
\tfile_server
}`,
  `${apiUrl.hostname} {
\theader {
\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"
\t\tX-Content-Type-Options "nosniff"
\t\tReferrer-Policy "no-referrer"
\t\t-Server
\t}
\treverse_proxy 127.0.0.1:${port}
}`,
];

// Optional: send www.<web domain> to the web domain (needs a DNS record for www too).
if (process.env.DEPLOY_WWW_REDIRECT === "true") {
  blocks.push(`www.${webUrl.hostname} {
\theader -Server
\tredir https://${webUrl.hostname}{uri} permanent
}`);
}

process.stdout.write(`${blocks.join("\n\n")}\n`);
