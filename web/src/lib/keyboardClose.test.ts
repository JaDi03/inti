import { describe, expect, it } from "vitest";
import { keyboardCloseWatcher } from "./keyboardClose";

describe("keyboardCloseWatcher", () => {
  it("says closed once when the height comes back after a keyboard", () => {
    const closed = keyboardCloseWatcher(800, 400);
    expect(closed(500, 400)).toBe(false);
    expect(closed(650, 400)).toBe(false);
    expect(closed(800, 400)).toBe(true);
    expect(closed(800, 400)).toBe(false);
  });

  it("ignores small changes from the browser's own bars", () => {
    const closed = keyboardCloseWatcher(800, 400);
    expect(closed(740, 400)).toBe(false);
    expect(closed(800, 400)).toBe(false);
  });

  it("starts over when the phone turns", () => {
    const closed = keyboardCloseWatcher(800, 400);
    expect(closed(500, 400)).toBe(false);
    expect(closed(400, 800)).toBe(false);
    expect(closed(400, 800)).toBe(false);
  });
});
