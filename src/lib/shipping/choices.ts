import { z } from "zod";

/**
 * What a person set up for one order on its page (the boxes, what each
 * weighs, which items go where, the signature, the service), kept with the
 * order so it can be set up at a desk and bought at the packing computer.
 * It outranks packing memory and rules. Never an address: a change to where
 * a label goes stays on the screen it was typed on.
 *
 * Pure: no network, no database, safe in the browser.
 */
const inches = z.number().positive().max(108);

export const savedChoiceSchema = z.object({
  v: z.literal(1),
  /** One to six boxes, in order. */
  boxes: z
    .array(
      z.object({
        /** A saved box, or null for a size typed in. */
        box_id: z.string().uuid().nullable(),
        length: inches,
        width: inches,
        height: inches,
        /** The packed weight a person typed, in tenths of an ounce. Null: follow the items. */
        weight_tenth_oz: z.number().int().positive().max(24_000).nullable(),
        /** Units of each line in this box, by line id. */
        items: z.record(z.string().max(120), z.number().int().min(0).max(100_000)),
      }),
    )
    .min(1)
    .max(6),
  /** Null: nothing chosen, so rules decide. "none" is a choice: no signature even when a rule asks. */
  signature: z.enum(["none", "signature", "adult"]).nullable().default(null),
  /** The service picked, by name ("UPS Ground"). Null: rules decide, else the cheapest. */
  service: z.string().trim().min(1).max(120).nullable().default(null),
});
export type SavedChoice = z.infer<typeof savedChoiceSchema>;

/** The saved choice on an order's plan, or null when there is none (or it isn't usable). */
export function parseSavedChoice(value: unknown): SavedChoice | null {
  if (!value || typeof value !== "object") return null;
  const parsed = savedChoiceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
