import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/** The key file name that .gitignore keeps out of git at any depth. */
export const KEY_FILE_NAME = "inti-key.json";

/**
 * Why a key file path is refused, or null when it is fine. Inside the repository only the
 * ignored name is allowed, so the private key can never be committed by accident.
 */
export function keyPathProblem(path: string, repoRoot: string): string | null {
  const target = resolve(path);
  const rel = relative(resolve(repoRoot), target);
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside && basename(target) !== KEY_FILE_NAME) {
    return `${path} is inside the repository. Name it ${KEY_FILE_NAME} or write it outside the repository.`;
  }
  return null;
}
