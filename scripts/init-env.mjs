// Creates .env from .env.example on first run and fills in every value Inti generates itself,
// then lists the values the owner still has to fill in from their own accounts.
// Usage:
//   node scripts/init-env.mjs --data <dir>            a computer running pnpm server locally
//   node scripts/init-env.mjs --data <dir> --server   the server behind Caddy (scripts/deploy.sh)
//   add --check to stop with an error while an owner value is still empty
// Inti's key is created once in <dir> and never replaced: every user adds its public key to their
// own account, so a new key would make them all sign again. The same goes for SERVER_GRANT_KEY,
// which decrypts the stored trading grants.
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { KeyPair } from "near-api-js";

const args = process.argv.slice(2);
const dataIndex = args.indexOf("--data");
const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : undefined;
if (!dataDir) {
  console.error("usage: node scripts/init-env.mjs --data <dir> [--server] [--check]");
  process.exit(1);
}
const server = args.includes("--server");
const check = args.includes("--check");

/** Values the owner brings from their own accounts. */
const OWNER_VALUES = [
  "NEAR_AI_API_KEY",
  "NEAR_INTENTS_AGENT_API_KEY",
  "NEAR_INTENTS_AGENT_API_URL",
  "PRIVY_APP_ID",
  "PRIVY_VERIFICATION_KEY",
  "INTI_API_URL",
  "SERVER_ALLOWED_ORIGINS",
];

if (!existsSync(".env")) copyFileSync(".env.example", ".env");
// Lines are kept as they are (comments included); a value is replaced in place or appended.
const lines = readFileSync(".env", "utf8").replace(/\r/g, "").split("\n");
const get = (name) => lines.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? "";
const set = (name, value) => {
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${name}=${value}`);
};

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyFile = resolve(dataDir, "inti-key.json");
if (!existsSync(keyFile)) {
  const pair = KeyPair.fromRandom("ed25519");
  writeFileSync(keyFile, `${JSON.stringify({ publicKey: pair.getPublicKey().toString(), secretKey: pair.toString() })}\n`, { flag: "wx", mode: 0o600 });
  console.log(`== created Inti's key in ${keyFile}`);
}
const key = JSON.parse(readFileSync(keyFile, "utf8"));
if (KeyPair.fromString(key.secretKey).getPublicKey().toString() !== key.publicKey) throw new Error(`${keyFile} does not match its own public key`);
const listed = get("INTI_KEY_PUBLIC");
if (listed && listed !== key.publicKey) {
  throw new Error(`INTI_KEY_PUBLIC in .env is not the key in ${keyFile}; users signed for the one in .env, so nothing was changed`);
}
set("INTI_KEY_PUBLIC", key.publicKey);
set("SERVER_INTI_KEY_FILE", keyFile);

if (!get("SERVER_GRANT_KEY")) {
  set("SERVER_GRANT_KEY", randomBytes(32).toString("base64"));
  console.log("== created SERVER_GRANT_KEY");
}

// The app signs grants only for the Agent API host the server talks to.
const agentApiUrl = get("NEAR_INTENTS_AGENT_API_URL");
if (agentApiUrl) set("INTI_AGENT_API_HOST", new URL(agentApiUrl).host);

if (server) {
  // Behind Caddy on the same machine: only the proxy reaches the API, and grants live in the data folder.
  set("SERVER_HOST", "127.0.0.1");
  set("SERVER_TRUSTED_PROXY", "127.0.0.1");
  set("SERVER_GRANT_FILE", resolve(dataDir, "grants.json"));
  if (!get("SERVER_PORT")) set("SERVER_PORT", "8787");
}

writeFileSync(".env", lines.join("\n"));
// Secrets live in this file, so only its owner may read it.
chmodSync(".env", 0o600);

const missing = OWNER_VALUES.filter((name) => !get(name) || (server && /localhost/.test(get(name))));
if (missing.length === 0) {
  console.log("== .env is complete");
} else {
  console.log(`== fill in these values in .env: ${missing.join(", ")}`);
  if (check) process.exit(1);
}
