// Creates the two server secrets a new Inti deployment needs:
//  - Inti's ed25519 key: written to the given file (mode 600), which SERVER_INTI_KEY_FILE
//    points to. Each user adds its public key to their own account as a function-call key
//    that may only call fund_agent, so it never needs funds of its own.
//  - SERVER_GRANT_KEY: 32 random bytes that encrypt the stored trading grants.
// Usage: node scripts/new-keys.mjs <path for the key file>
// It refuses to overwrite a file: replacing Inti's key cuts off every user who added the old one.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/new-keys.mjs <path for the key file>");
  process.exit(1);
}

const pair = KeyPair.fromRandom("ed25519");
const publicKey = pair.getPublicKey().toString();
writeFileSync(path, `${JSON.stringify({ publicKey, secretKey: pair.toString() })}\n`, { flag: "wx", mode: 0o600 });

console.log(`Inti key written to ${path}. Put these lines in your .env:`);
console.log(`INTI_KEY_PUBLIC=${publicKey}`);
console.log(`SERVER_GRANT_KEY=${randomBytes(32).toString("base64")}`);
