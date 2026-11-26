import { localDay, zonedTimeToUtc } from "../bookings/slots";
import { LOGO_LIGHT_TAG, LOGO_TAG } from "./photo-match";
import type { ReviewDay, SocialPlan } from "./plan";

/**
 * The monthly run's rules, pure so they can be tested (ported from the
 * Content Hub's `drafting.ts` and made multi-tenant: every brand has its own
 * review day, and the times are on the workspace's own clock).
 *
 * A month runs from one review day (the nth weekday of the month, the first
 * Monday unless changed) to the day before the next. Times whose topic is
 * filled "from projects" get a carousel of a project's photos that no post
 * has used yet; the other times get a post Claude writes from the topic.
 * What is decided here is only a plan: the database re-checks every draft
 * (`file_social_month_draft`), and nothing is ever scheduled by it.
 */

const DAY_MS = 86_400_000;
const ymd = (date: Date) => date.toISOString().slice(0, 10);
const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** The nth (1 to 4) weekday (0 is Sunday) of the month `day` falls in, as YYYY-MM-DD. */
export function nthWeekday(day: string, week: number, weekday: number): string {
  const first = new Date(Date.UTC(asDate(day).getUTCFullYear(), asDate(day).getUTCMonth(), 1));
  const offset = ((weekday - first.getUTCDay() + 7) % 7) + (week - 1) * 7;
  return ymd(new Date(first.getTime() + offset * DAY_MS));
}

const nextMonth = (day: string) => {
  const date = asDate(day);
  return ymd(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)));
};

/** The review day on or after `today` (YYYY-MM-DD on the workspace's clock). */
export function comingReviewDay(today: string, day: Pick<ReviewDay, "week" | "weekday">): string {
  const here = nthWeekday(today, day.week, day.weekday);
  return here >= today ? here : nthWeekday(nextMonth(today), day.week, day.weekday);
}

/** The last day of the month that starts on review day `start`. */
export function monthEnd(start: string, day: Pick<ReviewDay, "week" | "weekday">): string {
  return ymd(
    new Date(asDate(nthWeekday(nextMonth(start), day.week, day.weekday)).getTime() - DAY_MS),
  );
}

/** The month a run made today would draft by itself, or null before its lead time begins. */
export function monthDue(today: string, day: Pick<ReviewDay, "week" | "weekday" | "lead_days">) {
  const coming = comingReviewDay(today, day);
  const gap = (asDate(coming).getTime() - asDate(today).getTime()) / DAY_MS;
  return gap <= Math.max(0, day.lead_days) ? coming : null;
}

export type MonthWindow = { start: string; end: string };

/** The month a run started today drafts: from the coming review day to the day before the next. */
export function upcomingMonth(today: string, day: ReviewDay): MonthWindow {
  const start = comingReviewDay(today, day);
  return { start, end: monthEnd(start, day) };
}

type BrandRef = { id: string; is_default: boolean };

/** A brand's review day: its own, or for the main brand an entry that names no brand. */
export function reviewDayFor(plan: SocialPlan, brand: BrandRef): ReviewDay | null {
  return (
    plan.review_days.find((day) => day.brand_id === brand.id) ??
    (brand.is_default ? plan.review_days.find((day) => day.brand_id === null) : undefined) ??
    null
  );
}

const forBrand = (brandId: string | null, brand: BrandRef) =>
  brandId === brand.id || (brandId === null && brand.is_default);

export type MonthPost = {
  status: string;
  scheduled_for: string | null;
  planned_for: string | null;
  brand_id: string | null;
};

export type MonthSlot = {
  at: string;
  day: string;
  time: string;
  topic: string | null;
  /** "project": a carousel from a project's photos. "topic": a post Claude writes. */
  kind: "project" | "topic";
  /** What Claude writes for it: words alone, or designed slides with their caption. */
  makes: "caption" | "slides";
};

/**
 * The plan's times for this brand inside the month that nothing is lined up
 * for: in the future, and with no post of the brand (scheduled, or a draft
 * pencilled in) at that very time.
 */
export function monthSlots(
  plan: SocialPlan,
  window: MonthWindow,
  brand: BrandRef,
  posts: MonthPost[],
  now: Date,
  timeZone: string,
): MonthSlot[] {
  const taken = new Set(
    posts
      .filter((post) => post.status !== "failed" && forBrand(post.brand_id, brand))
      .map((post) => post.scheduled_for ?? post.planned_for)
      .filter((at): at is string => Boolean(at))
      .map((at) => new Date(at).getTime()),
  );
  const fromProjects = new Set(
    plan.topics.filter((topic) => topic.from === "projects").map((topic) => topic.id),
  );
  const asSlides = new Set(
    plan.topics.filter((topic) => topic.makes === "slides").map((topic) => topic.id),
  );
  const slots: MonthSlot[] = [];
  const last = asDate(window.end).getTime();
  for (let time = asDate(window.start).getTime(); time <= last; time += DAY_MS) {
    const date = new Date(time);
    const day = ymd(date);
    for (const slot of plan.slots) {
      if (slot.weekday !== date.getUTCDay() || !forBrand(slot.brand_id, brand)) continue;
      const [hours, minutes] = slot.time.split(":").map(Number);
      const at = zonedTimeToUtc(day, hours * 60 + minutes, timeZone);
      if (!at || at.getTime() <= now.getTime() || taken.has(at.getTime())) continue;
      taken.add(at.getTime());
      slots.push({
        at: at.toISOString(),
        day,
        time: slot.time,
        topic: slot.topic,
        kind: slot.topic && fromProjects.has(slot.topic) ? "project" : "topic",
        makes: slot.topic && asSlides.has(slot.topic) ? "slides" : "caption",
      });
    }
  }
  return slots.sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------------------
// Projects: which photos haven't been posted, and the carousel for each time
// ---------------------------------------------------------------------------

export type PhotoRole = "process" | "finished" | "artwork";

export type ProjectPhoto = {
  id: string;
  projectId: string | null;
  /** When it was added. */
  createdAt: string;
  /** When it was taken, read from the photo itself; null when it doesn't say. */
  takenAt?: string | null;
  /** What a person marked it as. Unmarked counts as a process shot. */
  role?: PhotoRole | null;
  mimeType: string;
  tags: string[];
  hidden: boolean;
};

export type MonthProject = { id: string; name: string; note: string; topic: string | null };

/** At least this many unposted photos make a carousel; at most this many go in one. */
export const MIN_NEW_PHOTOS = 2;
export const MAX_CAROUSEL = 6;
/** A carousel ends on at most this many finished photos. */
export const MAX_FINISHED = 2;

// Artwork and logos are never a project's story.
const NOT_STORY = new Set(["designed", "banner", LOGO_TAG, LOGO_LIGHT_TAG]);

/** When a photo was taken, else when it was added: the order a project's story is told in. */
export const photoTime = (photo: Pick<ProjectPhoto, "takenAt" | "createdAt">) => {
  const taken = photo.takenAt ? Date.parse(photo.takenAt) : Number.NaN;
  return Number.isNaN(taken) ? Date.parse(photo.createdAt) : taken;
};

/**
 * In the order they were taken; a photo that doesn't say when goes after the
 * ones that do, by when it was added (the Content Hub's `byTakenAt`).
 */
export function byTakenAt<T extends Pick<ProjectPhoto, "takenAt" | "createdAt" | "id">>(
  a: T,
  b: T,
): number {
  const ta = a.takenAt ? Date.parse(a.takenAt) : Number.NaN;
  const tb = b.takenAt ? Date.parse(b.takenAt) : Number.NaN;
  const hasA = !Number.isNaN(ta);
  const hasB = !Number.isNaN(tb);
  if (hasA && hasB && ta !== tb) return ta - tb;
  if (hasA !== hasB) return hasA ? -1 : 1;
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Every photo already on a post, whatever became of the post, or pictured on its slides. */
export function usedPhotos(
  posts: { asset_id: string | null; asset_ids: string[] | null }[],
  pictured: Iterable<string> = [],
) {
  const used = new Set<string>(pictured);
  for (const post of posts) {
    if (post.asset_id) used.add(post.asset_id);
    for (const id of post.asset_ids ?? []) used.add(id);
  }
  return used;
}

/**
 * The library photos a post's slides picture, by id: a slide shows a photo
 * by its stored address, which ends in the photo's storage path.
 */
export function picturedOnSlides(
  slides: unknown,
  photos: { id: string; storage_path: string }[],
): string[] {
  if (!slides) return [];
  const text = JSON.stringify(slides);
  return photos.filter((photo) => text.includes(photo.storage_path)).map((photo) => photo.id);
}

/** Keep `count` items spread evenly across the list, always the first and the last. */
export function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  if (count <= 0) return [];
  if (count === 1) return items.slice(0, 1);
  const out: T[] = [];
  for (let i = 0; i < count; i++)
    out.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  return out;
}

/**
 * A project's photos that can go in a post, in the order they were taken:
 * pictures, not hidden, not artwork, not used before.
 */
export function freshPhotos(photos: ProjectPhoto[], used: Set<string>): ProjectPhoto[] {
  return photos
    .filter(
      (photo) =>
        photo.mimeType.startsWith("image/") &&
        !photo.hidden &&
        photo.role !== "artwork" &&
        !used.has(photo.id) &&
        !photo.tags.some((tag) => NOT_STORY.has(tag.toLowerCase())),
    )
    .sort(byTakenAt);
}

/**
 * The photos for one carousel, in the order they tell the story (the
 * Content Hub's `chooseCarousel`): process shots as they were taken, thinned
 * evenly (always the first and the last), then up to two finished photos.
 * Empty when fewer than two are new.
 */
export function chooseCarousel(photos: ProjectPhoto[], used: Set<string>, max = MAX_CAROUSEL) {
  const fresh = freshPhotos(photos, used);
  if (fresh.length < MIN_NEW_PHOTOS) return [];
  const finished = fresh.filter((photo) => photo.role === "finished").slice(-MAX_FINISHED);
  const process = fresh.filter((photo) => !finished.includes(photo));
  return [...spread(process, Math.max(0, max - finished.length)), ...finished];
}

/** The topic a project's posts belong to: its own "from projects" topic, else the first one. */
export function projectTopic(project: MonthProject, plan: SocialPlan): string | null {
  const fromProjects = plan.topics.filter((topic) => topic.from === "projects");
  return (
    fromProjects.find((topic) => topic.id === project.topic)?.id ?? fromProjects[0]?.id ?? null
  );
}

export type ProjectPick = { project: MonthProject; photos: ProjectPhoto[] };

/**
 * Lines up the month's project times: for each, a project and its photos, or
 * null when no project of that time's topic has enough new photos. Projects
 * take turns, newest photos first; no photo is used twice, and a project
 * doesn't follow itself while another one could go.
 */
export function planProjects(
  plan: SocialPlan,
  projects: MonthProject[],
  photos: ProjectPhoto[],
  used: Set<string>,
  slots: Pick<MonthSlot, "topic">[],
): (ProjectPick | null)[] {
  const taken = new Set(used);
  const byProject = new Map<string, ProjectPhoto[]>();
  for (const photo of photos) {
    if (!photo.projectId) continue;
    byProject.set(photo.projectId, [...(byProject.get(photo.projectId) ?? []), photo]);
  }
  const own = (project: MonthProject) => byProject.get(project.id) ?? [];
  const newest = (project: MonthProject) =>
    Math.max(0, ...freshPhotos(own(project), taken).map(photoTime));
  const queue = projects
    .filter((project) => chooseCarousel(own(project), taken).length > 0)
    .sort((a, b) => newest(b) - newest(a) || a.id.localeCompare(b.id));
  const topicOf = new Map(queue.map((project) => [project.id, projectTopic(project, plan)]));

  let lastId = "";
  return slots.map((slot) => {
    const ready = (project: MonthProject) =>
      (slot.topic === null || topicOf.get(project.id) === slot.topic) &&
      chooseCarousel(own(project), taken).length > 0;
    const index = queue.findIndex((project) => ready(project) && project.id !== lastId);
    const at = index >= 0 ? index : queue.findIndex(ready);
    if (at < 0) return null;
    const [project] = queue.splice(at, 1);
    queue.push(project);
    const chosen = chooseCarousel(own(project), taken);
    for (const photo of chosen) taken.add(photo.id);
    lastId = project.id;
    return { project, photos: chosen };
  });
}

/** How many drafts one run writes at most. */
export const MAX_RUN_DRAFTS = 31;

/** Today on the workspace's clock. */
export const todayIn = (now: Date, timeZone: string) => localDay(now, timeZone);

const WEEKS = ["first", "second", "third", "fourth"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "the first Monday of the month". */
export const reviewDayWords = (day: Pick<ReviewDay, "week" | "weekday">) =>
  `the ${WEEKS[day.week - 1]} ${DAYS[day.weekday]} of the month`;
