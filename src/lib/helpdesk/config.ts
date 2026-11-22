import { z } from "zod";

/**
 * Help desk customisation is data (CLAUDE.md rule 4): reply templates and
 * auto-tag rules live in `configs` under module "helpdesk" and are parsed
 * with these schemas every time they are read.
 */

export const HELPDESK_MODULE = "helpdesk";
export const TEMPLATES_KEY = "reply_templates";
export const RULES_KEY = "auto_tag_rules";

const id = z.string().regex(/^[a-z0-9-]{1,40}$/);
export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,29}$/;

export const replyTemplatesSchema = z.object({
  version: z.literal(1),
  templates: z
    .array(
      z.object({
        id,
        name: z.string().trim().min(1).max(60),
        body: z.string().trim().min(1).max(4000),
      }),
    )
    .max(50),
});
export type ReplyTemplates = z.infer<typeof replyTemplatesSchema>;

export const autoTagRulesSchema = z.object({
  version: z.literal(1),
  rules: z
    .array(
      z.object({
        id,
        /** Words to look for, in any letter case. */
        contains: z.string().trim().min(2).max(80),
        where: z.enum(["subject", "body", "anywhere"]).default("anywhere"),
        tag: z.string().trim().toLowerCase().regex(TAG_PATTERN),
      }),
    )
    .max(50),
});
export type AutoTagRules = z.infer<typeof autoTagRulesSchema>;

export const DEFAULT_TEMPLATES: ReplyTemplates = {
  version: 1,
  templates: [
    {
      id: "thanks",
      name: "Thanks, looking into it",
      body: "Hi {{first_name}},\n\nThanks for getting in touch. I'm looking into this now and will come back to you shortly.",
    },
    {
      id: "late-shipping",
      name: "Order is running late",
      body: "Hi {{first_name}},\n\nI'm sorry your order is taking longer than expected. Each piece is made by hand and this one needed a little more time. I'll send tracking details as soon as it ships.",
    },
  ],
};

export const DEFAULT_RULES: AutoTagRules = {
  version: 1,
  rules: [
    { id: "shipping", contains: "shipping", where: "anywhere", tag: "shipping" },
    { id: "refund", contains: "refund", where: "anywhere", tag: "refund" },
    { id: "wholesale", contains: "wholesale", where: "anywhere", tag: "wholesale" },
  ],
};

/** Parses a stored config, falling back to the defaults when missing or unreadable. */
export function parseTemplates(body: unknown): ReplyTemplates {
  const parsed = replyTemplatesSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_TEMPLATES;
}

export function parseRules(body: unknown): AutoTagRules {
  const parsed = autoTagRulesSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_RULES;
}

/** The tags an email earns under the workspace's rules. */
export function tagsFor(rules: AutoTagRules, email: { subject: string; body: string }): string[] {
  const subject = email.subject.toLowerCase();
  const body = email.body.toLowerCase();
  const tags = new Set<string>();
  for (const rule of rules.rules) {
    const needle = rule.contains.toLowerCase();
    const hit =
      rule.where === "subject"
        ? subject.includes(needle)
        : rule.where === "body"
          ? body.includes(needle)
          : subject.includes(needle) || body.includes(needle);
    if (hit) tags.add(rule.tag);
  }
  return [...tags];
}

/** Fills `{{first_name}}` and friends; unknown placeholders are left for the person to see. */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => values[key] ?? whole);
}
