import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("That email address doesn't look right."));

export const workspaceSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give your workspace a name.")
    .max(80, "Keep the name under 80 characters."),
  timezone: z.string().min(1, "Pick a timezone."),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Pick a currency."),
});

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(["admin", "member"]),
});

export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Something in the form isn't right.";
}
