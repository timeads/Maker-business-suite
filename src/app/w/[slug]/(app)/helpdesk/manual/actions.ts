"use server";

import { revalidatePath, updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { HELPDESK_MODULE, TAG_PATTERN } from "@/lib/helpdesk/config";
import {
  MANUAL_KEY,
  facetValues,
  manualConfigSchema,
  parseManual,
  topicFacetsSchema,
  type TopicFacets,
} from "@/lib/helpdesk/manual/config";
import {
  articleEntry,
  loadArticles,
  loadManualConfig,
  loadSuggestions,
  loadTopic,
  loadTopics,
  topicEntry,
} from "@/lib/helpdesk/manual/data";
import {
  HELP_CENTRE_KEY,
  helpCentrePath,
  parseHelpCentre,
} from "@/lib/helpdesk/help-centre/config";
import { helpCentreTag } from "@/lib/helpdesk/help-centre-server";
import { applySuggestion } from "@/lib/helpdesk/manual/plan";
import { searchEntries } from "@/lib/helpdesk/manual/search";
import { docText, sectionText, splitSections } from "@/lib/helpdesk/manual/sections";
import { parseRichDoc, tidyDoc, type RichDoc } from "@/lib/helpdesk/rich";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type ManualState = { error?: string; message?: string };

const NO_ACCESS = "The help desk isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const TRY_AGAIN = "That didn't save. Try again in a moment.";
const UUID = /^[0-9a-f-]{36}$/;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/helpdesk/manual`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.helpdesk")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return {
    tenant: ctx.tenant,
    role: ctx.role,
    entitlements,
    supabase: await createClient(),
  } as const;
}

const base = (slug: string) => `/w/${slug}/helpdesk/manual`;
const refresh = (slug: string) => {
  revalidatePath(base(slug), "layout");
  revalidatePath(`/w/${slug}/helpdesk`);
};

/** The body the editor handed over, checked: a document of our own kind or nothing. */
function bodyOf(formData: FormData): RichDoc | null {
  try {
    const doc = parseRichDoc(JSON.parse(String(formData.get("body") ?? "[]")));
    return doc ? tidyDoc(doc) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/** Writes a new topic, or saves a change to one. Anyone on the team. */
export async function saveTopic(
  slug: string,
  topicId: string | null,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "Give the topic a title." };
  const body = bodyOf(formData);
  if (!body) return { error: "That couldn't be read. Try typing it again." };
  const config = await loadManualConfig(ctx.supabase, ctx.tenant.id);
  const facets: TopicFacets = config.facets.flatMap((facet) =>
    facetValues(facet.id, String(formData.get(`facet_${facet.id}`) ?? "")),
  );
  // Values under a facet the workspace has since taken away are kept as they were.
  if (topicId) {
    const now = await loadTopic(ctx.supabase, ctx.tenant.id, topicId);
    const known = new Set(config.facets.map((f) => f.id));
    facets.push(...(now?.facets ?? []).filter((f) => !known.has(f.facet)));
  }
  const checked = topicFacetsSchema.safeParse(facets);
  if (!checked.success) return { error: "That's too many labels for one topic." };
  const { data, error } = await ctx.supabase.rpc("save_manual_topic", {
    p_tenant_id: ctx.tenant.id,
    p_topic_id: topicId,
    p_title: title,
    p_summary: String(formData.get("summary") ?? ""),
    p_body: body,
    p_facets: checked.data,
  });
  if (error || !data) return { error: TRY_AGAIN };
  refresh(slug);
  redirect(`${base(slug)}/${data}`);
}

/** Publishes or unpublishes a topic. Owners and admins; the database checks again. */
export async function publishTopic(slug: string, topicId: string, publish: boolean): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !canManage(ctx.role)) return;
  await ctx.supabase.rpc("set_manual_topic_state", {
    p_tenant_id: ctx.tenant.id,
    p_topic_id: topicId,
    p_status: publish ? "published" : "draft",
    p_use_in_drafts: null,
  });
  refresh(slug);
}

/** Whether a published topic may be handed to a reply draft as reference. */
export async function setTopicInDrafts(slug: string, topicId: string, use: boolean): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !canManage(ctx.role)) return;
  await ctx.supabase.rpc("set_manual_topic_state", {
    p_tenant_id: ctx.tenant.id,
    p_topic_id: topicId,
    p_status: null,
    p_use_in_drafts: use,
  });
  refresh(slug);
}

export async function deleteTopic(slug: string, topicId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !canManage(ctx.role)) return;
  const { error } = await ctx.supabase.rpc("delete_manual_topic", {
    p_tenant_id: ctx.tenant.id,
    p_topic_id: topicId,
  });
  refresh(slug);
  if (!error) redirect(base(slug));
}

/**
 * Accepts a suggested update: its points are added to the topic as it reads
 * today (nothing already there is changed), by the same code that plans a
 * reading. With `thenEdit` the person lands in the editor to reword it.
 */
export async function acceptSuggestion(
  slug: string,
  topicId: string,
  suggestionId: string,
  thenEdit: boolean,
): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const [topic, suggestions, config] = await Promise.all([
    loadTopic(ctx.supabase, ctx.tenant.id, topicId),
    loadSuggestions(ctx.supabase, ctx.tenant.id, topicId),
    loadManualConfig(ctx.supabase, ctx.tenant.id),
  ]);
  const suggestion = suggestions.find((one) => one.id === suggestionId);
  if (!topic || !suggestion) return;
  const next = applySuggestion(topic, suggestion, config.sections);
  await ctx.supabase.rpc("decide_manual_suggestion", {
    p_tenant_id: ctx.tenant.id,
    p_suggestion_id: suggestionId,
    p_accept: true,
    p_body: next.body,
    p_facets: next.facets,
  });
  refresh(slug);
  if (thenEdit) redirect(`${base(slug)}/${topicId}?edit=1`);
}

export async function dismissSuggestion(slug: string, suggestionId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  await ctx.supabase.rpc("decide_manual_suggestion", {
    p_tenant_id: ctx.tenant.id,
    p_suggestion_id: suggestionId,
    p_accept: false,
  });
  refresh(slug);
}

/** Brings an earlier version back, as a new change by the person who pressed it. */
export async function restoreRevision(slug: string, topicId: string, revisionId: string) {
  const ctx = await context(slug);
  if ("error" in ctx || !UUID.test(revisionId)) return;
  const { data } = await ctx.supabase
    .from("manual_topic_revisions")
    .select("title, summary, body, facets")
    .eq("tenant_id", ctx.tenant.id)
    .eq("topic_id", topicId)
    .eq("id", revisionId)
    .maybeSingle();
  const body = parseRichDoc(data?.body);
  const facets = topicFacetsSchema.safeParse(data?.facets);
  if (!data || !body) return;
  await ctx.supabase.rpc("save_manual_topic", {
    p_tenant_id: ctx.tenant.id,
    p_topic_id: topicId,
    p_title: data.title,
    p_summary: data.summary,
    p_body: body,
    p_facets: facets.success ? facets.data : [],
  });
  refresh(slug);
  redirect(`${base(slug)}/${topicId}`);
}

// ---------------------------------------------------------------------------
// Updates: asking the worker to read conversations
// ---------------------------------------------------------------------------

const RUN_ERRORS: Record<string, string> = {
  too_soon: "It was brought up to date a few minutes ago. Give it ten minutes.",
  too_many: "That's enough for one day. It can be asked again tomorrow.",
  not_found: "That conversation couldn't be found.",
};

async function requestRun(slug: string, ticketId: string | null): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can ask for an update." };
  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: "Writing with Claude isn't switched on for this environment yet." };
  }
  const { error } = await ctx.supabase.rpc("request_manual_run", {
    p_tenant_id: ctx.tenant.id,
    p_ticket_id: ticketId,
  });
  if (error) {
    const known = Object.keys(RUN_ERRORS).find((key) => error.message.includes(key));
    return {
      error: known ? RUN_ERRORS[known] : "That couldn't be started. Try again in a moment.",
    };
  }
  refresh(slug);
  return {
    message: ticketId
      ? "It will be read in the next minute or so. What it adds shows up as a draft topic or a suggested update."
      : "Started. New topics arrive as drafts over the next few minutes; refresh to see them.",
  };
}

/** "Update now": read the source conversations not yet read. */
export async function updateManualNow(slug: string, _prev: ManualState): Promise<ManualState> {
  void _prev;
  return requestRun(slug, null);
}

/** "Add to the manual" on one conversation, whatever folder or tag it has. */
export async function addTicketToManual(
  slug: string,
  ticketId: string,
  _prev: ManualState,
): Promise<ManualState> {
  void _prev;
  if (!UUID.test(ticketId)) return { error: RUN_ERRORS.not_found };
  return requestRun(slug, ticketId);
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

export async function saveArticle(
  slug: string,
  articleId: string | null,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { error: "Give the article a title." };
  const body = bodyOf(formData);
  if (!body) return { error: "That couldn't be read. Try typing it again." };
  const tags = [
    ...new Set(
      String(formData.get("tags") ?? "")
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (tags.length > 12 || tags.some((tag) => !TAG_PATTERN.test(tag))) {
    return {
      error: "Up to twelve tags, each short and made of letters, numbers, spaces or dashes.",
    };
  }
  const { data, error } = await ctx.supabase.rpc("save_manual_article", {
    p_tenant_id: ctx.tenant.id,
    p_article_id: articleId,
    p_title: title,
    p_body: body,
    p_tags: tags,
    p_shareable: formData.get("shareable") === "1",
  });
  if (error || !data) {
    return {
      error: error?.message.includes("Only owners and admins")
        ? "This article is published on your help centre, so only an owner or admin can change it."
        : TRY_AGAIN,
    };
  }
  refresh(slug);
  // A published help article is on a public page: show the change there at once.
  updateTag(helpCentreTag(slug));
  redirect(`${base(slug)}/kb/${data}`);
}

export async function deleteArticle(slug: string, articleId: string): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx || !canManage(ctx.role)) return;
  const { error } = await ctx.supabase.rpc("delete_manual_article", {
    p_tenant_id: ctx.tenant.id,
    p_article_id: articleId,
  });
  refresh(slug);
  updateTag(helpCentreTag(slug));
  if (!error) redirect(`${base(slug)}/kb`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const lines = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);

const facetId = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20) || "label";

/** Settings → Help desk → Manual. Owners and admins. */
export async function saveManualSettings(
  slug: string,
  _prev: ManualState,
  formData: FormData,
): Promise<ManualState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!canManage(ctx.role))
    return { error: "Only owners and admins can change help desk settings." };
  const { data: current } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", HELPDESK_MODULE)
    .eq("key", MANUAL_KEY)
    .maybeSingle();
  const now = parseManual(current?.body);
  // A facet keeps its id when its label is only reworded in place, so topics keep their values.
  const labels = lines(formData.get("facets")).slice(0, 4);
  const used = new Set<string>();
  const facets = labels.map((label, at) => {
    const kept = now.facets[at]?.id;
    let id = kept && !used.has(kept) ? kept : facetId(label);
    while (used.has(id)) id = `${id.slice(0, 18)}-${used.size}`;
    used.add(id);
    return { id, label };
  });
  const parsed = manualConfigSchema.safeParse({
    version: 1,
    name: String(formData.get("name") ?? "").trim() || "Manual",
    topics_label: String(formData.get("topics_label") ?? "").trim() || "Topics",
    about: String(formData.get("about") ?? "").trim(),
    facets,
    sections: lines(formData.get("sections")),
    sources: {
      folders: formData.getAll("folder").map(String),
      views: formData.getAll("view").map(String),
      tags: lines(formData.get("tags")).map((tag) => tag.toLowerCase()),
    },
    auto: formData.get("auto") === "1",
    every: formData.get("every") === "week" ? "week" : "day",
    monthly_cap: Number(formData.get("monthly_cap") ?? now.monthly_cap),
    read_photos: formData.get("read_photos") === "1",
    use_in_drafts: formData.get("use_in_drafts") === "1",
  });
  if (!parsed.success) {
    const where = String(parsed.error.issues[0]?.path[0] ?? "");
    const words: Record<string, string> = {
      name: "The name can be up to 40 characters, without < or >.",
      topics_label: "The tab's name can be up to 30 characters, without < or >.",
      about: "Keep “what belongs in it” under 300 characters, without < or >.",
      facets: "Up to four labels, each different and up to 30 characters.",
      sections: "Between one and eight headings, each different and up to 40 characters.",
      sources: "Up to ten folders, ten views and ten tags; tags are short and lower case.",
      monthly_cap: "The monthly limit is a whole number from 0 to 1000.",
    };
    return { error: words[where] ?? "Something there isn't in a shape we can save." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: HELPDESK_MODULE,
    p_key: MANUAL_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}`, "layout");
  return { message: "Saved." };
}

// ---------------------------------------------------------------------------
// The picker in the reply box
// ---------------------------------------------------------------------------

export type ManualHit = {
  id: string;
  kind: "topic" | "article";
  title: string;
  labels: string[];
  /** The whole entry as plain text. */
  text: string;
  /** Its sections, for putting just one into a reply. */
  sections: { heading: string; text: string }[];
  /** Where customers can read it: only for an article published on a help centre that is on. */
  publicUrl: string | null;
};

/**
 * Finds published topics and articles for the reply box's "Manual" picker.
 * Plain text search over what this member can read; no model is asked. What
 * comes back is only ever put into the reply box for a person to edit.
 */
export async function findInManual(slug: string, query: string): Promise<ManualHit[]> {
  const ctx = await context(slug);
  if ("error" in ctx) return [];
  const [topics, articles, { data: centre }, site] = await Promise.all([
    loadTopics(ctx.supabase, ctx.tenant.id),
    loadArticles(ctx.supabase, ctx.tenant.id),
    ctx.supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", ctx.tenant.id)
      .eq("module", HELPDESK_MODULE)
      .eq("key", HELP_CENTRE_KEY)
      .maybeSingle(),
    getSiteUrl(),
  ]);
  const centreOn = parseHelpCentre(centre?.body).on;
  const links = new Map<string, string>();
  for (const article of articles) {
    if (centreOn && article.publicState === "published" && article.slug) {
      links.set(article.id, `${site}${helpCentrePath(ctx.tenant.slug, article.slug)}`);
    }
  }
  const bodies = new Map<string, RichDoc>();
  const entries = [
    ...topics
      .filter((topic) => topic.status === "published")
      .map((topic) => {
        bodies.set(topic.id, topic.body);
        return topicEntry(topic);
      }),
    ...articles.map((article) => {
      bodies.set(article.id, article.body);
      return articleEntry(article);
    }),
  ];
  return searchEntries(entries, String(query).slice(0, 100))
    .slice(0, 8)
    .map((entry) => {
      const body = bodies.get(entry.id) ?? [];
      return {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        labels: entry.labels.slice(0, 4),
        text: docText(body).slice(0, 6000),
        sections: splitSections(body)
          .filter((section) => section.heading !== null)
          .map((section) => ({
            heading: section.heading!,
            text: sectionText(section).slice(0, 4000),
          }))
          .filter((section) => section.text)
          .slice(0, 8),
        publicUrl: entry.kind === "article" ? (links.get(entry.id) ?? null) : null,
      };
    });
}
