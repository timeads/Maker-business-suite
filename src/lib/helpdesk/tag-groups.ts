import { z } from "zod";
import { TAG_PATTERN } from "./config";

/**
 * Tags in groups ("Product", "Problem"), as the owner's help desk shows them
 * in its tag picker. A setting like any other (`configs`, module "helpdesk").
 * A group only arranges the picker: a tag in no group still works.
 */
export const TAG_GROUPS_KEY = "tag_groups";

export const tagGroupsSchema = z.object({
  version: z.literal(1),
  groups: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,40}$/),
        name: z.string().trim().min(1).max(40),
        tags: z.array(z.string().trim().toLowerCase().regex(TAG_PATTERN)).min(1).max(30),
      }),
    )
    .max(20),
});
export type TagGroups = z.infer<typeof tagGroupsSchema>;
export const DEFAULT_TAG_GROUPS: TagGroups = { version: 1, groups: [] };

export function parseTagGroups(body: unknown): TagGroups {
  const parsed = tagGroupsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_TAG_GROUPS;
}

/**
 * The tags to offer, arranged: each group with its tags, then "Other" for the
 * known tags in no group. Tags already on the conversation are left out, and
 * `find` narrows by what was typed. Empty groups are dropped.
 */
export function groupTags(
  groups: TagGroups["groups"],
  known: string[],
  options: { on?: string[]; find?: string } = {},
): { name: string; tags: string[] }[] {
  const on = new Set(options.on ?? []);
  const find = (options.find ?? "").trim().toLowerCase();
  const offer = (tag: string) => !on.has(tag) && (!find || tag.includes(find));
  const grouped = new Set(groups.flatMap((group) => group.tags));
  const out = groups.map((group) => ({ name: group.name, tags: group.tags.filter(offer) }));
  const other = known.filter((tag) => !grouped.has(tag) && offer(tag));
  if (other.length > 0) out.push({ name: groups.length > 0 ? "Other" : "Tags", tags: other });
  return out.filter((group) => group.tags.length > 0);
}
