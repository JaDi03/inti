/**
 * Creates Inti's function-call key: the private key stays in a JSON file on the server
 * (SERVER_INTI_KEY_FILE), the public key goes in INTI_KEY_PUBLIC. An existing file is never
 * replaced, because users' accounts already trust the key it holds.
 *
 *   pnpm new-key              writes ./inti-key.json
 *   pnpm new-key path/to/key.json
 */
import { writeFile } from "node:fs/promises";
import { KeyPair } from "near-api-js";

async function main(): Promise<void> {
  const path = process.argv[2] ?? "./inti-key.json";
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  const file = JSON.stringify({ publicKey, secretKey: pair.toString() }, null, 2) + "\n";
  try {
    // "wx" fails when the file exists; 0o600 keeps the key readable by its owner only.
    await writeFile(path, file, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(`${path} already exists and was left unchanged.`);
      process.exit(1);
    }
    throw err;
  }
  console.log(`Wrote ${path}. Put these in .env:`);
  console.log(`SERVER_INTI_KEY_FILE=${path}`);
  console.log(`INTI_KEY_PUBLIC=${publicKey}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
