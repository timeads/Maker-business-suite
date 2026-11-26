import type { SupabaseClient } from "@supabase/supabase-js";
import { BRAND_COLUMNS, pickBrand, type Brand } from "../brand/brands";
import { BRAND_MODULE, brandBrief, parseBrandKit } from "../brand/kit";
import {
  GRANT_COLUMNS,
  SUMMARY_COLUMNS,
  resolveEntitlements,
  type PlanGrant,
} from "../entitlements";
import { postAlert } from "../messages/alerts";
import { withTenant } from "../supabase/admin";
import {
  MAX_RUN_DRAFTS,
  monthSlots,
  planProjects,
  spread,
  usedPhotos,
  type MonthPost,
  type MonthProject,
  type ProjectPhoto,
} from "./month";
import {
  MAX_PHOTO_BYTES,
  MAX_SHOWN,
  PHOTO_TYPES,
  tidyCaption,
  type MonthPostInput,
  type MonthWriter,
  type PhotoType,
} from "./month-writer";
import { pickPhoto } from "./photo-match";
import { PLAN_KEY, SOCIAL_MODULE, parsePlan } from "./plan";
import { editLessons, parseStyleNotes, styleNotesKey } from "./style-notes";

/**
 * One claimed monthly run, on the worker: for one brand's coming month,
 * line up the open times (`monthSlots`), give each project time a carousel
 * of unposted photos (`planProjects`) and each other time a post from its
 * topic, ask Claude for the words (structured output, no tools), tidy them
 * and hand each draft to `file_social_month_draft`, the only writer. Tenant
 * data is read only through `withTenant`.
 *
 * It stops, saying why, when the month's AI allowance runs out. Nothing here
 * schedules or posts: every draft waits for a person (CLAUDE.md rule 6).
 */

export type ClaimedMonthRun = {
  id: string;
  tenant_id: string;
  brand_id: string;
  window_start: string;
  window_end: string;
  source: "schedule" | "manual";
};

export type MonthRunDeps = {
  admin: SupabaseClient;
  write: MonthWriter;
  now(): Date;
  /** A stored photo's bytes by its storage path. Null when it can't be read. */
  loadPhoto?: (path: string) => Promise<Uint8Array | null>;
  /** For tests: the heads-up, instead of Messages. */
  alert?: (tenantId: string, text: string) => Promise<void>;
};

export type MonthCounts = {
  drafted: number;
  projects: number;
  topics: number;
  /** Project times no project had enough new photos for. */
  empty: number;
  failed: number;
  stopped: "allowance" | "off" | "no_times" | null;
};

type AssetRow = {
  id: string;
  storage_path: string;
  mime_type: string;
  title: string | null;
  tags: string[] | null;
  hidden: boolean;
  project_id: string | null;
  created_at: string;
};

type Loaded = {
  tenant: { name: string; timezone: string };
  brand: Brand | null;
  plan: ReturnType<typeof parsePlan>;
  brief: string;
  learned: string;
  lessons: ReturnType<typeof editLessons>;
  recent: string[];
  posts: (MonthPost & { asset_id: string | null; asset_ids: string[] | null })[];
  projects: MonthProject[];
  assets: AssetRow[];
  allowance: number;
};

const rows = <T>(data: unknown) => (data ?? []) as T[];

async function load(run: ClaimedMonthRun, deps: MonthRunDeps): Promise<Loaded> {
  const monthStart = new Date(deps.now());
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: tenant } = await deps.admin
    .from("tenants")
    .select("name, timezone")
    .eq("id", run.tenant_id)
    .maybeSingle();
  return withTenant(
    run.tenant_id,
    async (scope) => {
      const [brands, configs, sub, grant, usage, posts, projects, assets, edits] =
        await Promise.all([
          scope.select("brands", BRAND_COLUMNS),
          scope.select("configs", "module, key, body").in("module", [SOCIAL_MODULE, BRAND_MODULE]),
          scope.select("subscriptions", SUMMARY_COLUMNS).maybeSingle(),
          scope.select("plan_grants", GRANT_COLUMNS).maybeSingle(),
          scope
            .select("usage_events", "quantity")
            .eq("type", "ai_tokens")
            .gte("occurred_at", monthStart.toISOString())
            .limit(5000),
          scope
            .select(
              "social_posts",
              "status, scheduled_for, planned_for, brand_id, asset_id, asset_ids, caption, published_at",
            )
            .order("created_at", { ascending: false })
            .limit(5000),
          scope
            .select("social_projects", "id, name, note, topic")
            .is("archived_at", null)
            .limit(500),
          scope
            .select(
              "social_assets",
              "id, storage_path, mime_type, title, tags, hidden, project_id, created_at",
            )
            .like("mime_type", "image/%")
            .eq("hidden", false)
            .order("created_at", { ascending: false })
            .limit(3000),
          scope
            .select("social_post_edits", "before, after")
            .eq("brand_id", run.brand_id)
            .order("edited_at", { ascending: false })
            .limit(10),
        ]);
      const brand =
        rows<Brand>(brands.data).find((b) => b.id === run.brand_id) ??
        pickBrand(rows<Brand>(brands.data), run.brand_id);
      const config = (module: string, key: string) =>
        rows<{ module: string; key: string; body: unknown }>(configs.data).find(
          (c) => c.module === module && c.key === key,
        )?.body;
      const entitlements = resolveEntitlements(
        sub.data as never,
        grant.error ? null : (grant.data as PlanGrant | null),
      );
      const used = rows<{ quantity: number | string }>(usage.data).reduce(
        (sum, row) => sum + Number(row.quantity),
        0,
      );
      const allPosts = rows<
        Loaded["posts"][number] & { caption: string; published_at: string | null }
      >(posts.data);
      return {
        tenant: {
          name: (tenant as { name?: string } | null)?.name ?? "",
          timezone: (tenant as { timezone?: string } | null)?.timezone ?? "UTC",
        },
        brand,
        plan: parsePlan(config(SOCIAL_MODULE, PLAN_KEY)),
        brief: brandBrief(parseBrandKit(config(BRAND_MODULE, brand?.kit_key ?? "kit"))),
        learned: parseStyleNotes(config(SOCIAL_MODULE, styleNotesKey(brand))).notes,
        lessons: editLessons(rows<{ before: string; after: string }>(edits.data)),
        recent: allPosts
          .filter((p) => p.status === "published" && p.brand_id === run.brand_id && p.caption)
          .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))
          .slice(0, 5)
          .map((p) => p.caption.slice(0, 600)),
        posts: allPosts,
        projects: rows<{ id: string; name: string; note: string | null; topic: string | null }>(
          projects.data,
        ).map((p) => ({ id: p.id, name: p.name, note: p.note ?? "", topic: p.topic })),
        assets: rows<AssetRow>(assets.data),
        allowance:
          entitlements.canWrite && entitlements.can("module.social")
            ? Math.max(0, entitlements.limit("ai_credits") - used)
            : -1,
      };
    },
    deps.admin,
  );
}

async function defaultLoadPhoto(admin: SupabaseClient, path: string): Promise<Uint8Array | null> {
  const { data, error } = await admin.storage.from("social").download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** Up to four of a carousel's photos, spread across it, that can be shown to Claude. */
async function shownPhotos(
  assets: AssetRow[],
  deps: MonthRunDeps,
): Promise<MonthPostInput["photos"]> {
  const load = deps.loadPhoto ?? ((path: string) => defaultLoadPhoto(deps.admin, path));
  const out: MonthPostInput["photos"] = [];
  for (const asset of spread(assets, MAX_SHOWN)) {
    if (!(PHOTO_TYPES as readonly string[]).includes(asset.mime_type)) continue;
    const bytes = await load(asset.storage_path).catch(() => null);
    if (!bytes || bytes.byteLength > MAX_PHOTO_BYTES) continue;
    out.push({ type: asset.mime_type as PhotoType, base64: Buffer.from(bytes).toString("base64") });
  }
  return out;
}

/** The run's result in a sentence, for the plan page and the run's record. */
export function describeMonthRun(counts: Partial<MonthCounts>): string {
  const parts: string[] = [];
  const drafted = counts.drafted ?? 0;
  if (counts.stopped === "off") return "Social isn't part of this workspace's plan right now.";
  if (counts.stopped === "no_times") {
    return "There were no open posting times in that month for this brand. Add times to the plan.";
  }
  parts.push(
    drafted === 0
      ? "Nothing was drafted."
      : `Drafted ${drafted} ${drafted === 1 ? "post" : "posts"}${
          counts.projects ? ` (${counts.projects} from projects)` : ""
        }.`,
  );
  if (counts.empty) {
    parts.push(
      `${counts.empty} project ${counts.empty === 1 ? "time was" : "times were"} left empty: no project had two or more photos that haven't been posted.`,
    );
  }
  if (counts.failed) parts.push(`${counts.failed} couldn't be written.`);
  if (counts.stopped === "allowance") {
    parts.push("It stopped because this month's AI allowance is used up.");
  }
  return parts.join(" ");
}

const monthWords = (day: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(
    new Date(`${day}T00:00:00Z`),
  );

/** Runs one claimed month. Returns a line for the worker's log. */
export async function runClaimedMonth(run: ClaimedMonthRun, deps: MonthRunDeps): Promise<string> {
  const counts: MonthCounts = {
    drafted: 0,
    projects: 0,
    topics: 0,
    empty: 0,
    failed: 0,
    stopped: null,
  };
  const finish = async (status: "done" | "failed", error: string | null = null) => {
    const { error: finishError } = await deps.admin.rpc("finish_social_month_run", {
      p_id: run.id,
      p_status: status,
      p_counts: counts,
      p_error: error ?? (status === "failed" ? describeMonthRun(counts) : null),
    });
    if (finishError) console.error(`Could not finish month run ${run.id}: ${finishError.message}`);
    return `${status}: ${describeMonthRun(counts)}`;
  };

  try {
    const loaded = await load(run, deps);
    if (loaded.allowance < 0) {
      counts.stopped = "off";
      return finish("failed");
    }
    const brand = loaded.brand ?? { id: run.brand_id, is_default: true, name: "", kit_key: "kit" };
    const slots = monthSlots(
      loaded.plan,
      { start: run.window_start, end: run.window_end },
      { id: run.brand_id, is_default: Boolean(brand.is_default) },
      loaded.posts,
      deps.now(),
      loaded.tenant.timezone,
    ).slice(0, MAX_RUN_DRAFTS);
    if (slots.length === 0) {
      counts.stopped = "no_times";
      return finish("done");
    }

    const used = usedPhotos(loaded.posts);
    const projectSlots = slots.filter((slot) => slot.kind === "project");
    const photos: ProjectPhoto[] = loaded.assets.map((asset) => ({
      id: asset.id,
      projectId: asset.project_id,
      createdAt: asset.created_at,
      mimeType: asset.mime_type,
      tags: asset.tags ?? [],
      hidden: asset.hidden,
    }));
    const picks = planProjects(loaded.plan, loaded.projects, photos, used, projectSlots);
    const pickFor = new Map(projectSlots.map((slot, index) => [slot.at, picks[index]]));
    const assetById = new Map(loaded.assets.map((asset) => [asset.id, asset]));
    // Photos for the topic posts are matched by their tags, each to one draft only.
    const tagged = loaded.assets.map((asset) => ({
      ...asset,
      title: asset.title ?? "",
      tags: asset.tags ?? [],
      mimeType: asset.mime_type,
    }));
    const taken = new Set<string>([
      ...used,
      ...picks.flatMap((p) => p?.photos.map((x) => x.id) ?? []),
    ]);

    let allowance = loaded.allowance;
    for (const slot of slots) {
      if (allowance <= 0) {
        counts.stopped = "allowance";
        break;
      }
      const topic = loaded.plan.topics.find((t) => t.id === slot.topic) ?? null;
      const pick = slot.kind === "project" ? pickFor.get(slot.at) : null;
      if (slot.kind === "project" && !pick) {
        counts.empty += 1;
        continue;
      }
      const match =
        !pick && topic ? pickPhoto(tagged, `${topic.name} ${topic.about}`, taken) : null;
      const chosen = pick
        ? pick.photos.map((photo) => assetById.get(photo.id)).filter((a): a is AssetRow => !!a)
        : match
          ? [match.asset]
          : [];
      let result: Awaited<ReturnType<MonthWriter>>;
      try {
        result = await deps.write({
          business: brand.is_default || !brand.name ? loaded.tenant.name : brand.name,
          brand: loaded.brief,
          houseStyle: loaded.plan.style_notes,
          learned: loaded.learned,
          lessons: loaded.lessons,
          recent: loaded.recent,
          topic: topic ? { name: topic.name, about: topic.about } : null,
          project: pick
            ? { name: pick.project.name, note: pick.project.note, photoCount: chosen.length }
            : null,
          photos: await shownPhotos(chosen, deps),
        });
      } catch (err) {
        console.error(
          `month run ${run.id}: Claude couldn't be reached`,
          err instanceof Error ? err.message : err,
        );
        counts.failed += 1;
        break;
      }
      allowance -= result.tokens;
      // Metered whether or not a draft came back: the tokens were spent.
      const { error: usageError } = await deps.admin.rpc("record_usage", {
        p_tenant_id: run.tenant_id,
        p_type: "ai_tokens",
        p_quantity: result.tokens,
      });
      if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
      const caption = result.ok ? tidyCaption(result.post.caption) : null;
      if (!caption) {
        counts.failed += 1;
        continue;
      }
      const { data: id, error } = await deps.admin.rpc("file_social_month_draft", {
        p_run_id: run.id,
        p_draft: {
          kind: pick ? "project" : "topic",
          planned_for: slot.at,
          caption,
          asset_ids: chosen.map((asset) => asset.id),
          project_id: pick?.project.id ?? null,
          topic: slot.topic,
        },
      });
      if (error) {
        console.error(`month run ${run.id}: a draft couldn't be filed: ${error.message}`);
        counts.failed += 1;
        continue;
      }
      if (!id) continue;
      counts.drafted += 1;
      if (pick) counts.projects += 1;
      else counts.topics += 1;
      for (const asset of chosen) taken.add(asset.id);
    }

    if (counts.drafted > 0) {
      const text = `The monthly run drafted ${counts.drafted} ${counts.drafted === 1 ? "post" : "posts"}${
        brand.name && !brand.is_default ? ` for ${brand.name}` : ""
      }, for ${monthWords(run.window_start)} to ${monthWords(run.window_end)}. They're waiting in Social → Review; nothing goes out until someone approves or schedules it.`;
      if (deps.alert) await deps.alert(run.tenant_id, text);
      else await postAlert(deps.admin, run.tenant_id, "social", text);
    }
    return finish(counts.drafted === 0 && counts.failed > 0 ? "failed" : "done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`month run ${run.id} failed: ${message}`);
    return finish("failed", "The run couldn't be finished. Try again in a little while.");
  }
}

/** For the plan page: a run's record in words. */
export type MonthRunRow = {
  id: string;
  brand_id: string;
  window_start: string;
  window_end: string;
  status: "queued" | "running" | "done" | "failed";
  source: "schedule" | "manual";
  created_at: string;
  finished_at: string | null;
  counts: Partial<MonthCounts>;
  error: string | null;
};
