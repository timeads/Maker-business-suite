import { z } from "zod";
import { localDay, zonedTimeToUtc } from "../bookings/slots";

/**
 * A workspace's content plan: what it posts about, when, in what voice, and
 * the links on its link page. Data, like every setting: `configs`, module
 * "social".
 */
export const SOCIAL_MODULE = "social";
export const PLAN_KEY = "plan";
export const LINKS_KEY = "links";

const id = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const socialPlanSchema = z.object({
  version: z.literal(1),
  /** The kinds of post the business makes: process shots, new work, workshops… */
  topics: z
    .array(
      z.object({
        id,
        name: z.string().trim().min(1).max(40),
        about: z.string().trim().max(300).default(""),
      }),
    )
    .max(12)
    .default([]),
  /** The times it likes to post each week, each with the topic that usually goes there. */
  slots: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        topic: id.nullable().default(null),
      }),
    )
    .max(21)
    .default([]),
  /** How the business sounds. Claude reads this before drafting anything. */
  style_notes: z.string().trim().max(3000).default(""),
});
export type SocialPlan = z.infer<typeof socialPlanSchema>;
export const DEFAULT_PLAN: SocialPlan = socialPlanSchema.parse({ version: 1 });

export function parsePlan(body: unknown): SocialPlan {
  const parsed = socialPlanSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_PLAN;
}

export const linkPageSchema = z.object({
  version: z.literal(1),
  published: z.boolean().default(false),
  heading: z.string().trim().max(80).default(""),
  intro: z.string().trim().max(300).default(""),
  links: z
    .array(
      z.object({
        id,
        label: z.string().trim().min(1).max(60),
        // Only ordinary web links: nothing that could run script when tapped.
        url: z
          .string()
          .trim()
          .max(500)
          .regex(/^https:\/\/[^\s<>"']+$/),
      }),
    )
    .max(20)
    .default([]),
  /**
   * The brand the page speaks for: its name heads the page, and its posts'
   * photos are the ones shown. Null: the workspace's main brand.
   */
  brand_id: z.string().uuid().nullable().default(null),
  /** Show the latest posted photos under the links. */
  show_posts: z.boolean().default(true),
});
export type LinkPage = z.infer<typeof linkPageSchema>;
export const DEFAULT_LINKS: LinkPage = linkPageSchema.parse({ version: 1 });

export function parseLinkPage(body: unknown): LinkPage {
  const parsed = linkPageSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_LINKS;
}

/** "Label | https://…" per line, the way the settings box is typed. */
export function linksFromText(text: string): { links: LinkPage["links"] } | { error: string } {
  const links: LinkPage["links"] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const cut = line.lastIndexOf("|");
    const label = (cut === -1 ? "" : line.slice(0, cut)).trim();
    let url = (cut === -1 ? line : line.slice(cut + 1)).trim();
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(url)) url = `https://${url}`;
    if (!/^https:\/\/[^\s<>"']+$/.test(url)) {
      return { error: `Line ${index + 1} needs a web address starting with https://` };
    }
    links.push({
      id: `l${index + 1}`,
      label: (label || url.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "")).slice(0, 60),
      url,
    });
  }
  if (links.length > 20) return { error: "A link page can hold up to 20 links." };
  return { links };
}

export const linksToText = (page: LinkPage) =>
  page.links.map((link) => `${link.label} | ${link.url}`).join("\n");

export type PlannedPost = {
  status: string;
  scheduled_for: string | null;
  planned_for: string | null;
  topic: string | null;
};

export type OpenSlot = { day: string; time: string; topic: string | null; at: string };

/**
 * The plan's posting times over the coming days that nothing is lined up
 * for yet. A slot counts as taken when a post (scheduled, posted, or a draft
 * meant for then) sits on that day at that time, or on that day for the same
 * topic.
 */
export function openSlots(
  plan: SocialPlan,
  posts: PlannedPost[],
  now: Date,
  days: number,
  timeZone: string,
): OpenSlot[] {
  const taken = new Set<string>();
  for (const post of posts) {
    const at = post.scheduled_for ?? post.planned_for;
    if (!at || post.status === "failed") continue;
    const instant = new Date(at);
    const day = localDay(instant, timeZone);
    const time = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(instant);
    taken.add(`${day} ${time}`);
    if (post.topic) taken.add(`${day} #${post.topic}`);
  }
  const [y, m, d] = localDay(now, timeZone).split("-").map(Number);
  const open: OpenSlot[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(Date.UTC(y, m - 1, d + offset));
    const day = date.toISOString().slice(0, 10);
    for (const slot of plan.slots) {
      if (slot.weekday !== date.getUTCDay()) continue;
      const [hours, minutes] = slot.time.split(":").map(Number);
      const at = zonedTimeToUtc(day, hours * 60 + minutes, timeZone);
      if (!at || at.getTime() <= now.getTime()) continue;
      if (taken.has(`${day} ${slot.time}`)) continue;
      if (slot.topic && taken.has(`${day} #${slot.topic}`)) continue;
      open.push({ day, time: slot.time, topic: slot.topic, at: at.toISOString() });
    }
  }
  return open.sort((a, b) => a.at.localeCompare(b.at));
}

/** How a month went against the plan: posts per topic, and per channel. */
export function monthReview(
  plan: SocialPlan,
  posts: { status: string; topic: string | null; channels: string[] }[],
) {
  const published = posts.filter((post) => post.status === "published");
  const perWeek = new Map<string | null, number>();
  for (const slot of plan.slots) perWeek.set(slot.topic, (perWeek.get(slot.topic) ?? 0) + 1);
  const topics = plan.topics.map((topic) => ({
    id: topic.id,
    name: topic.name,
    posted: published.filter((post) => post.topic === topic.id).length,
    // About four and a third weeks in a month.
    planned: Math.round((perWeek.get(topic.id) ?? 0) * 4.33),
  }));
  const other = published.filter(
    (post) => !post.topic || !plan.topics.some((topic) => topic.id === post.topic),
  ).length;
  const channels = new Map<string, number>();
  for (const post of published) {
    for (const channel of post.channels) channels.set(channel, (channels.get(channel) ?? 0) + 1);
  }
  return {
    posted: published.length,
    failed: posts.filter((post) => post.status === "failed").length,
    topics,
    other,
    channels: [...channels].sort((a, b) => b[1] - a[1]),
  };
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
