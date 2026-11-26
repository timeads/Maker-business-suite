import { z } from "zod";
import type { Role } from "../tenants";

/**
 * How a workspace reviews its posts before they go out: who may approve, and
 * whether a post must be approved before it can be scheduled at all. Data,
 * like every setting (`configs`, module "social", key "review"); the database
 * reads the same body (`private.can_approve_social`,
 * `private.social_requires_approval`), so a page can't decide differently.
 *
 * Out of the box nothing changes: approval isn't required (anyone who can
 * write can schedule, as before), and owners and admins are the approvers.
 */
export const REVIEW_KEY = "review";

export const APPROVER_ROLES = ["owner", "admin", "member"] as const;

export const reviewSettingsSchema = z.object({
  version: z.literal(1),
  /** On: only an approver can schedule; everyone else sends posts for review. */
  require_approval: z.boolean().default(false),
  /** The roles that may approve. Owners always may, whatever this says. */
  approvers: z
    .array(z.enum(APPROVER_ROLES))
    .max(3)
    .default(["owner", "admin"])
    .transform((roles) => [...new Set<Role>(["owner", ...roles])]),
});
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;
export const DEFAULT_REVIEW: ReviewSettings = reviewSettingsSchema.parse({ version: 1 });

export function parseReview(body: unknown): ReviewSettings {
  const parsed = reviewSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_REVIEW;
}

/** Whether someone with this role may approve, sending back included. Mirrors the database. */
export function canApprove(role: Role, settings: ReviewSettings): boolean {
  return role === "owner" || settings.approvers.includes(role);
}

/** Whether someone with this role may schedule a post straight away. */
export function canSchedule(role: Role, settings: ReviewSettings): boolean {
  return !settings.require_approval || canApprove(role, settings);
}

/** What the review and approve functions answer, in plain words. */
export const REVIEW_ERRORS: Record<string, string> = {
  needs_approval: "This workspace approves posts before they go out. Send it for review instead.",
  not_approver: "Only the people this workspace chose can approve posts.",
  needs_note: "Say what to change, so whoever wrote it knows.",
  no_time: "Pick a date and time for it first.",
  no_channel: "Pick where this should be posted.",
  empty: "Add a caption or a photo first.",
  instagram_needs_photo: "Instagram posts need a photo.",
  past: "Its time has passed. Pick a time in the future.",
  locked: "This post has already gone out, so it can't be changed.",
  too_many: "That's more than 200 posts at once. Approve a smaller batch.",
  slides_not_drawn:
    "Its slides haven't been made into pictures yet. Open it and approve it from there.",
  slides_changed: "The slides changed while they were being drawn. Please try again.",
  slides_count: "Every slide needs its picture. Please try again.",
  too_many_photos: "A post can have up to 10 photos, slides included.",
};

/** The plain words for a database refusal, or null when it isn't one of ours. */
export function reviewError(message: string | undefined | null): string | null {
  if (!message) return null;
  const key = Object.keys(REVIEW_ERRORS).find((k) => message.includes(k));
  return key ? REVIEW_ERRORS[key] : null;
}

const ROLE_NAMES: Record<Role, string> = { owner: "owners", admin: "admins", member: "members" };

/** "Owners and admins", for the settings page and the assistant. */
export function approverWords(settings: ReviewSettings): string {
  const names = APPROVER_ROLES.filter((r) => settings.approvers.includes(r)).map(
    (r) => ROLE_NAMES[r],
  );
  const text = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return text.charAt(0).toUpperCase() + text.slice(1);
}
