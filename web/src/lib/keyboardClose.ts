import { useEffect } from "react";

/** Height a phone keyboard takes at least; smaller changes are the browser's own bars. */
const KEYBOARD_MIN_PX = 150;

/**
 * Follows the visible height of the page and says when a phone keyboard has just closed: the
 * height came back near its full size after dropping by a keyboard's height. A width change
 * (the phone turned) starts over, since the full height changes with it.
 */
export function keyboardCloseWatcher(height: number, width: number): (height: number, width: number) => boolean {
  let full = height;
  let lastWidth = width;
  let open = false;
  return (h, w) => {
    if (w !== lastWidth) {
      lastWidth = w;
      full = h;
      open = false;
      return false;
    }
    full = Math.max(full, h);
    if (full - h >= KEYBOARD_MIN_PX) {
      open = true;
      return false;
    }
    if (!open) return false;
    open = false;
    return true;
  };
}

/**
 * On Android, closing the keyboard with the back or hide button leaves the text box focused, so
 * anything hidden while typing would stay hidden. When the keyboard closes, the text box lets go
 * of its focus and the menu comes back.
 */
export function useBlurOnKeyboardClose(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const closed = keyboardCloseWatcher(viewport.height, viewport.width);
    const onResize = () => {
      if (!closed(viewport.height, viewport.width)) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLTextAreaElement) focused.blur();
    };
    viewport.addEventListener("resize", onResize);
    return () => viewport.removeEventListener("resize", onResize);
  }, []);
}
