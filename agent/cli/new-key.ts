/**
 * Creates Inti's function-call key: the private key stays in a JSON file on the server
 * (SERVER_INTI_KEY_FILE), the public key goes in INTI_KEY_PUBLIC. An existing file is never
 * replaced, because users' accounts already trust the key it holds.
 *
 *   pnpm new-key                      writes ./inti-key.json (ignored by git)
 *   pnpm new-key /etc/inti/key.json   any path outside the repository
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { KEY_FILE_NAME, keyPathProblem } from "./keyPath.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function main(): Promise<void> {
  const path = process.argv[2] ?? `./${KEY_FILE_NAME}`;
  const problem = keyPathProblem(path, REPO_ROOT);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();
  const file = JSON.stringify({ publicKey, secretKey: pair.toString() }, null, 2) + "\n";
  try {
    // "wx" fails when the file exists. On Linux and macOS, 0o600 keeps the key readable by its
    // owner only; Windows ignores it and the file takes the folder's permissions.
    await writeFile(path, file, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(`${path} already exists and was left unchanged.`);
      process.exit(1);
    }
    throw err;
  }
  if (process.platform === "win32") console.log("On Windows the file takes the folder's permissions: keep it in a folder only you can read.");
  console.log(`Wrote ${path}. Put these in .env:`);
  console.log(`SERVER_INTI_KEY_FILE=${path}`);
  console.log(`INTI_KEY_PUBLIC=${publicKey}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
