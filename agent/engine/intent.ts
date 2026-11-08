import { z } from "zod";

/** Decimal amount as a string, e.g. "10.5". Never a float. */
const amount = z.string().regex(/^\d+(\.\d+)?$/, "amount must be a positive decimal string");

const asset = z.object({
  symbol: z.string().min(1),
  chain: z.string().min(1),
});

/**
 * Structured intent. The engine only ever sees this object, never raw text,
 * so any interface (chat, widget, CLI) can produce it.
 */
export const intentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("swap"),
    from: asset,
    to: asset,
    amount,
  }),
  z.object({
    kind: z.literal("transfer"),
    asset,
    amount,
    recipient: z.string().min(1),
  }),
]);

export type Intent = z.infer<typeof intentSchema>;

export function parseIntent(input: unknown): Intent {
  return intentSchema.parse(input);
}
