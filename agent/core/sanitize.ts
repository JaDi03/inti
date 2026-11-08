/**
 * Token symbols and chain names come from GET /v1/tokens, which lists tokens with
 * free-form names (memecoins). They reach the model and the owner, so anything that
 * does not look like a symbol is replaced before it can carry instructions.
 * Every symbol in the live list (216 tokens, 2026-11-08) matches this pattern.
 */
const LABEL = /^[A-Za-z0-9.$_()-]{1,20}$/;

export function safeLabel(value: string): string {
  return LABEL.test(value) ? value : "UNKNOWN";
}
