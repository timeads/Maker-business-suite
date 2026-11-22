import { z } from "zod";

/**
 * The extra questions a workspace asks on its booking form are data
 * (CLAUDE.md rule 4): stored in `configs` under module "bookings" and parsed
 * with this schema on every read.
 */

export const BOOKINGS_MODULE = "bookings";
export const FORM_KEY = "booking_form";

export const bookingFormSchema = z.object({
  version: z.literal(1),
  questions: z
    .array(
      z.object({
        id: z.string().regex(/^q[0-9]{1,2}$/),
        label: z.string().trim().min(1).max(120),
        required: z.boolean(),
      }),
    )
    .max(8),
});
export type BookingForm = z.infer<typeof bookingFormSchema>;

export const DEFAULT_FORM: BookingForm = { version: 1, questions: [] };

export function parseBookingForm(body: unknown): BookingForm {
  const parsed = bookingFormSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_FORM;
}

/** One question per line; a line ending in * must be answered. */
export function questionsFromText(text: string): BookingForm {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    version: 1,
    questions: lines.map((line, i) => {
      const required = line.endsWith("*");
      return { id: `q${i + 1}`, label: line.replace(/\*+$/, "").trim(), required };
    }),
  };
}

export function questionsToText(form: BookingForm): string {
  return form.questions.map((q) => (q.required ? `${q.label} *` : q.label)).join("\n");
}

/** Reads the answers out of a submitted booking form. */
export function readAnswers(
  form: BookingForm,
  get: (name: string) => string,
): { answers: Record<string, string> } | { error: string } {
  const answers: Record<string, string> = {};
  for (const question of form.questions) {
    const value = get(`answer_${question.id}`).trim().slice(0, 1000);
    if (!value && question.required) return { error: `Please answer "${question.label}".` };
    if (value) answers[question.label] = value;
  }
  return { answers };
}
