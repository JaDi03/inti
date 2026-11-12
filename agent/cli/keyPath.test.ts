import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { keyPathProblem } from "./keyPath.js";

const ROOT = resolve("repo-root-for-test");

describe("keyPathProblem", () => {
  it("accepts the ignored name anywhere in the repository", () => {
    expect(keyPathProblem(join(ROOT, "inti-key.json"), ROOT)).toBeNull();
    expect(keyPathProblem(join(ROOT, "keys", "inti-key.json"), ROOT)).toBeNull();
  });

  it("refuses any other name inside the repository", () => {
    expect(keyPathProblem(join(ROOT, "key.json"), ROOT)).toMatch(/inside the repository/);
    expect(keyPathProblem(join(ROOT, "path", "to", "key.json"), ROOT)).toMatch(/inside the repository/);
    expect(keyPathProblem(join(ROOT, "agent", "..", "secret.json"), ROOT)).toMatch(/inside the repository/);
  });

  it("accepts any name outside the repository", () => {
    expect(keyPathProblem(join(ROOT, "..", "keys", "my-key.json"), ROOT)).toBeNull();
    expect(keyPathProblem(join(`${ROOT}-sibling`, "key.json"), ROOT)).toBeNull();
  });
});
