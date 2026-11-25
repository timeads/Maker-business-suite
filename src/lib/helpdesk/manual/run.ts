import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GRANT_COLUMNS,
  SUMMARY_COLUMNS,
  resolveEntitlements,
  type PlanGrant,
} from "../../entitlements";
import { withTenant } from "../../supabase/admin";
import { HELPDESK_MODULE, type Priority } from "../config";
import { FILES_BUCKET, filesNote, sniffType } from "../files";
import { parseRichDoc } from "../rich";
import { SAVED_VIEWS_KEY, parseSavedViews, type SavedView } from "../saved-views";
import { splitQuote } from "../thread";
import type { Shelf } from "../views";
import { MANUAL_KEY, hasSources, parseManual, parseTopicFacets, type ManualConfig } from "./config";
import { planReading, type Planned, type TopicState } from "./plan";
import {
  MAX_MESSAGES,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
  PHOTO_TYPES,
  SHORTLIST,
  tidyExtras,
  tidyReading,
  type ManualReader,
  type PhotoType,
  type ReadInput,
} from "./reader";
import { scrub, type ScrubFacts } from "./scrub";
import { closestEntries, type Entry } from "./search";
import { docText } from "./sections";
import { isSourceConversation, readsAllowed, type SourceTicket } from "./sources";

/**
 * One claimed update of a workspace's manual, on the worker: find the source
 * conversations not yet read, and for each one ask Claude what it adds, tidy
 * and scrub the answer, decide in code what to do with it (`planReading`)
 * and hand that to `apply_manual_reading`, the only writer. Tenant data is
 * touched only through `withTenant` or a function that names the run.
 *
 * It stops, saying why, when the month's AI allowance or the workspace's
 * own monthly cap runs out. Nothing here publishes a topic or writes to a
 * customer: new topics are drafts.
 */

export type ClaimedRun = {
  id: string;
  tenant_id: string;
  source: string;
  ticket_id: string | null;
};

/** What a topic may show from a conversation: pictures a browser can draw, and videos. */
export const CANDIDATE_TYPES = [...PHOTO_TYPES, "video/mp4", "video/quicktime"] as const;
/** How many of one conversation's files are offered to its topic. */
export const MAX_CANDIDATES = 12;

/** How many conversations one run reads at most. */
export const PER_RUN = 10;
/** How many closed conversations one run looks through for sources. */
const LOOK_BACK = 400;

export type ManualDeps = {
  admin: SupabaseClient;
  read: ManualReader;
  now(): Date;
  /** For tests: a kept file's bytes by its storage path. Null when it can't be read. */
  loadFile?: (path: string) => Promise<Uint8Array | null>;
};

export type RunCounts = {
  read: number;
  written: number;
  added: number;
  suggested: number;
  nothing: number;
  failed: number;
  /** Why it stopped before the end, if it did. */
  stopped: "allowance" | "cap" | "off" | "no_sources" | null;
  /** Source conversations still unread when it ended. */
  waiting: number;
};

type TicketRow = {
  id: string;
  subject: string;
  status: SourceTicket["status"];
  shelf: Shelf | null;
  merged_into: string | null;
  folder_id: string | null;
  assignee_id: string | null;
  priority: Priority;
  first_reply_at: string | null;
  contacts:
    { email: string; name: string | null } | { email: string; name: string | null }[] | null;
  ticket_tags: { tags: { name: string } | { name: string }[] | null }[] | null;
};
const TICKET_COLUMNS =
  "id, subject, status, shelf, merged_into, folder_id, assignee_id, priority, first_reply_at, contacts(email, name), ticket_tags(tags(name))";

const one = <T>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

function facts(
  row: TicketRow,
): SourceTicket & { contact: { email: string; name: string | null } | null } {
  const contact = one(row.contacts);
  return {
    id: row.id,
    status: row.status,
    shelf: row.shelf,
    merged_into: row.merged_into,
    folder_id: row.folder_id,
    assignee_id: row.assignee_id,
    priority: row.priority,
    tags: (row.ticket_tags ?? []).flatMap((t) => {
      const tag = one(t.tags);
      return tag ? [tag.name] : [];
    }),
    subject: row.subject,
    customer: `${contact?.name ?? ""} ${contact?.email ?? ""}`,
    replied: row.first_reply_at !== null,
    contact,
  };
}

type Loaded = {
  config: ManualConfig;
  savedViews: SavedView[];
  allowance: number;
  readThisMonth: number;
};

async function loadSettings(tenantId: string, deps: ManualDeps): Promise<Loaded> {
  const monthStart = new Date(deps.now());
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  return withTenant(
    tenantId,
    async (scope) => {
      const [{ data: configs }, { data: sub }, grant, { data: usage }, { data: reads }] =
        await Promise.all([
          scope
            .select("configs", "key, body")
            .eq("module", HELPDESK_MODULE)
            .in("key", [MANUAL_KEY, SAVED_VIEWS_KEY]),
          scope.select("subscriptions", SUMMARY_COLUMNS).maybeSingle(),
          scope.select("plan_grants", GRANT_COLUMNS).maybeSingle(),
          scope
            .select("usage_events", "quantity")
            .eq("type", "ai_tokens")
            .gte("occurred_at", monthStart.toISOString())
            .limit(5000),
          scope
            .select("manual_reads", "ticket_id")
            .gte("read_at", monthStart.toISOString())
            .limit(2000),
        ]);
      const body = (key: string) =>
        ((configs ?? []) as unknown as { key: string; body: unknown }[]).find((c) => c.key === key)
          ?.body;
      // The same resolver every gate uses (CLAUDE.md rule 7).
      const entitlements = resolveEntitlements(
        sub as never,
        grant.error ? null : (grant.data as PlanGrant | null),
      );
      const used = ((usage ?? []) as unknown as { quantity: number | string }[]).reduce(
        (sum, row) => sum + Number(row.quantity),
        0,
      );
      return {
        config: parseManual(body(MANUAL_KEY)),
        savedViews: parseSavedViews(body(SAVED_VIEWS_KEY)).views,
        allowance:
          entitlements.canWrite && entitlements.can("module.helpdesk")
            ? Math.max(0, entitlements.limit("ai_credits") - used)
            : -1,
        readThisMonth: (reads ?? []).length,
      };
    },
    deps.admin,
  );
}

/** The conversations to read: the one asked for, or the unread source conversations, newest first. */
async function pickTickets(
  run: ClaimedRun,
  loaded: Loaded,
  deps: ManualDeps,
): Promise<{ tickets: ReturnType<typeof facts>[]; waiting: number }> {
  return withTenant(
    run.tenant_id,
    async (scope) => {
      if (run.ticket_id) {
        const { data } = await scope.select("tickets", TICKET_COLUMNS).eq("id", run.ticket_id);
        const row = ((data ?? []) as unknown as TicketRow[])[0];
        const ticket = row ? facts(row) : null;
        // A person asked for this one, so its folder and status don't matter. A reply from us does.
        return {
          tickets: ticket && ticket.replied && !ticket.merged_into ? [ticket] : [],
          waiting: 0,
        };
      }
      const [{ data }, { data: reads }] = await Promise.all([
        scope
          .select("tickets", TICKET_COLUMNS)
          .eq("status", "closed")
          .order("last_message_at", { ascending: false })
          .limit(LOOK_BACK),
        scope.select("manual_reads", "ticket_id").limit(5000),
      ]);
      const done = new Set(
        ((reads ?? []) as unknown as { ticket_id: string }[]).map((r) => r.ticket_id),
      );
      const tickets = ((data ?? []) as unknown as TicketRow[])
        .map(facts)
        .filter(
          (ticket) =>
            !done.has(ticket.id) &&
            isSourceConversation(ticket, loaded.config.sources, loaded.savedViews),
        );
      return { tickets, waiting: tickets.length };
    },
    deps.admin,
  );
}

type TopicRow = {
  id: string;
  title: string;
  summary: string;
  body: unknown;
  facets: unknown;
  person_edited_at: string | null;
};

async function loadTopics(tenantId: string, deps: ManualDeps): Promise<TopicState[]> {
  return withTenant(
    tenantId,
    async (scope) => {
      const { data, error } = await scope
        .select("manual_topics", "id, title, summary, body, facets, person_edited_at")
        .order("updated_at", { ascending: false })
        .limit(500);
      if (error) throw new Error(`Could not read topics: ${error.message}`);
      return ((data ?? []) as unknown as TopicRow[]).map((row) => ({
        id: row.id,
        title: row.title,
        summary: row.summary,
        body: parseRichDoc(row.body) ?? [],
        facets: parseTopicFacets(row.facets),
        personEdited: row.person_edited_at !== null,
      }));
    },
    deps.admin,
  );
}

const topicEntry = (topic: TopicState): Entry & { topic: TopicState } => ({
  id: topic.id,
  kind: "topic",
  title: topic.title,
  summary: topic.summary,
  labels: topic.facets.map((f) => f.value),
  text: docText(topic.body),
  topic,
});

type MessageRow = {
  id: string;
  direction: string;
  body: string;
  created_at: string;
  kind: string;
  automatic?: boolean | null;
};
type FileRow = {
  id: string;
  message_id: string;
  name: string;
  mime_type: string;
  bytes: number;
  storage_path: string | null;
  state: string;
};

async function defaultLoadFile(admin: SupabaseClient, path: string): Promise<Uint8Array | null> {
  const { data, error } = await admin.storage.from(FILES_BUCKET).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** What is sent for one conversation: its words, scrubbed, and up to three of the customer's photos. */
export async function buildInput(
  ticket: ReturnType<typeof facts>,
  topics: TopicState[],
  config: ManualConfig,
  tenantId: string,
  deps: ManualDeps,
): Promise<{
  input: ReadInput;
  refs: Map<string, string>;
  scrubFacts: ScrubFacts;
  /** The customer's kept pictures and videos: what the topic may be offered. Ids only. */
  candidates: string[];
  /** Our picture reference (P1…) → the attachment it is. */
  photoRefs: Map<string, string>;
} | null> {
  const { messages, files } = await withTenant(
    tenantId,
    async (scope) => {
      const { data: rows } = await scope
        .select("messages", "id, direction, body, created_at, kind, automatic")
        .eq("ticket_id", ticket.id)
        .order("created_at", { ascending: true })
        .limit(MAX_MESSAGES * 2);
      // The automatic first reply is nobody's answer: it is neither read nor
      // counted as the team having replied.
      const list = ((rows ?? []) as unknown as MessageRow[]).filter(
        (m) => m.kind !== "forward" && m.automatic !== true,
      );
      const ids = list.map((m) => m.id);
      const { data: attached } =
        ids.length > 0
          ? await scope
              .select(
                "message_attachments",
                "id, message_id, name, mime_type, bytes, storage_path, state",
              )
              .in("message_id", ids)
          : { data: [] };
      return { messages: list, files: (attached ?? []) as unknown as FileRow[] };
    },
    deps.admin,
  );
  if (!messages.some((m) => m.direction === "outbound")) return null;

  const scrubFacts: ScrubFacts = { names: ticket.contact?.name ? [ticket.contact.name] : [] };
  const clean = (text: string) => scrub(text, scrubFacts);
  const thread = messages.slice(-MAX_MESSAGES).map((m) => ({
    from: m.direction === "inbound" ? ("customer" as const) : ("team" as const),
    at: String(m.created_at).slice(0, 10),
    // Each message once: what it quotes from earlier ones is left out.
    body: clean(splitQuote(String(m.body)).own),
    files: clean(filesNote(files.filter((f) => f.message_id === m.id))),
  }));

  const inbound = new Set(messages.filter((m) => m.direction === "inbound").map((m) => m.id));
  // What the topic may be offered to show: the customer's kept pictures and videos, by id.
  // A person picks from these; none is sent anywhere by being listed.
  const candidates = files
    .filter(
      (file) =>
        inbound.has(file.message_id) &&
        file.state === "kept" &&
        file.storage_path !== null &&
        (CANDIDATE_TYPES as readonly string[]).includes(file.mime_type),
    )
    .map((file) => file.id)
    .slice(0, MAX_CANDIDATES);

  // The customer's own photos only: kept files, pictures, small enough, never a video.
  const photos: ReadInput["photos"] = [];
  const photoRefs = new Map<string, string>();
  if (config.read_photos) {
    const load = deps.loadFile ?? ((path: string) => defaultLoadFile(deps.admin, path));
    for (const file of files) {
      if (photos.length >= MAX_PHOTOS) break;
      if (!inbound.has(file.message_id) || file.state !== "kept" || !file.storage_path) continue;
      if (!(PHOTO_TYPES as readonly string[]).includes(file.mime_type)) continue;
      if (file.bytes > MAX_PHOTO_BYTES || !file.storage_path.startsWith(`${tenantId}/`)) continue;
      const bytes = await load(file.storage_path).catch(() => null);
      if (!bytes || bytes.length > MAX_PHOTO_BYTES) continue;
      // By its own first bytes, as when it was kept.
      const type = sniffType(bytes);
      if (!type || !(PHOTO_TYPES as readonly string[]).includes(type)) continue;
      const ref = `P${photos.length + 1}`;
      photoRefs.set(ref, file.id);
      photos.push({ ref, type: type as PhotoType, base64: Buffer.from(bytes).toString("base64") });
    }
  }

  const subject = clean(ticket.subject);
  const text = `${subject}\n${thread.map((m) => m.body).join("\n")}`;
  const close = closestEntries(topics.map(topicEntry), text, { limit: SHORTLIST, minShared: 1 });
  const refs = new Map<string, string>();
  const shortlist = close.map((match, i) => {
    const ref = `T${i + 1}`;
    refs.set(ref, match.entry.id);
    return {
      ref,
      title: match.entry.title,
      summary: match.entry.summary,
      labels: match.entry.labels,
    };
  });
  return {
    input: { config, shortlist, subject, messages: thread, photos },
    refs,
    scrubFacts,
    candidates,
    photoRefs,
  };
}

/** The case line and the candidates, as `apply_manual_reading` takes them beside a plan. */
export type CaseFiling = {
  case: { summary: string; outcome: string } | null;
  media: { attachment_id: string; suggested: boolean; caption: string }[];
};

const planPayload = (plan: Planned, filing: CaseFiling | null): Record<string, unknown> => ({
  ...planBody(plan),
  // Only where the conversation ends up under a topic.
  ...(filing && plan.kind !== "nothing" ? { case: filing.case, media: filing.media } : {}),
});

const planBody = (plan: Planned): Record<string, unknown> => {
  switch (plan.kind) {
    case "new":
      return { ...plan };
    case "update":
      return {
        kind: "update",
        topic_id: plan.topicId,
        summary: plan.summary,
        body: plan.body,
        facets: plan.facets,
        additions: plan.additions,
        new_facets: plan.newFacets,
      };
    case "suggest":
      return {
        kind: "suggest",
        topic_id: plan.topicId,
        additions: plan.additions,
        new_facets: plan.newFacets,
      };
    case "seen":
      return { kind: "seen", topic_id: plan.topicId };
    default:
      return { kind: "nothing" };
  }
};

/** Whether an error from the API is about this request itself, so asking again would fail again. */
function refusedForGood(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 429 &&
    status !== 401 &&
    status !== 403
  );
}

export async function runClaimedManual(run: ClaimedRun, deps: ManualDeps): Promise<string> {
  const counts: RunCounts = {
    read: 0,
    written: 0,
    added: 0,
    suggested: 0,
    nothing: 0,
    failed: 0,
    stopped: null,
    waiting: 0,
  };
  const finish = async (status: "done" | "failed", error: string | null = null) => {
    const { error: finishError } = await deps.admin.rpc("finish_manual_run", {
      p_id: run.id,
      p_status: status,
      p_counts: counts,
      p_error: error,
    });
    if (finishError) console.error(`Could not finish manual run: ${finishError.message}`);
    return error ?? (counts.stopped ? `stopped (${counts.stopped})` : `read ${counts.read}`);
  };

  try {
    const loaded = await loadSettings(run.tenant_id, deps);
    if (loaded.allowance < 0) {
      counts.stopped = "off";
      return finish("done");
    }
    if (!run.ticket_id && !hasSources(loaded.config.sources)) {
      counts.stopped = "no_sources";
      return finish("done");
    }
    const { tickets, waiting } = await pickTickets(run, loaded, deps);
    counts.waiting = waiting;
    let left = loaded.allowance;
    let trouble = false;
    let mayRead = readsAllowed(loaded.config.monthly_cap, loaded.readThisMonth, PER_RUN);

    for (const ticket of tickets) {
      if (left <= 0) {
        counts.stopped = "allowance";
        break;
      }
      if (mayRead <= 0) {
        // A run of its own for the rest; at the month's cap, not until next month.
        if (loaded.readThisMonth + counts.read >= loaded.config.monthly_cap) counts.stopped = "cap";
        break;
      }
      // Fresh each time: the last conversation may have written the topic this one belongs to.
      const topics = await loadTopics(run.tenant_id, deps);
      const built = await buildInput(ticket, topics, loaded.config, run.tenant_id, deps);
      let plan: Planned | { kind: "failed" } = { kind: "nothing" };
      let filing: CaseFiling | null = null;
      if (built) {
        mayRead -= 1;
        counts.read += 1;
        try {
          const result = await deps.read(built.input);
          left -= result.tokens;
          if (result.tokens > 0) {
            const { error } = await deps.admin.rpc("record_usage", {
              p_tenant_id: run.tenant_id,
              p_type: "ai_tokens",
              p_quantity: result.tokens,
            });
            if (error) console.error(`Could not record AI usage: ${error.message}`);
          }
          const reading = result.ok
            ? tidyReading(result.reading, {
                refs: built.refs,
                config: loaded.config,
                facts: built.scrubFacts,
              })
            : null;
          if (reading) {
            const topic = topics.find((t) => t.id === reading.topicId) ?? null;
            plan = planReading(reading, topic, loaded.config.sections);
            // Beside the points: one line for the topic's cases, and the customer's
            // pictures and videos as candidates. Claude's picks are only a mark on a
            // candidate (pictures it was shown, never a video); a person keeps or not.
            const extras = result.ok
              ? tidyExtras(result.reading, {
                  shown: [...built.photoRefs.keys()],
                  facts: built.scrubFacts,
                })
              : { caseLine: null, photoPicks: [] };
            const picked = new Map(
              extras.photoPicks.map((pick) => [built.photoRefs.get(pick.ref)!, pick.caption]),
            );
            filing = {
              case: extras.caseLine,
              media: built.candidates.map((id) => ({
                attachment_id: id,
                suggested: picked.has(id),
                caption: picked.get(id) ?? "",
              })),
            };
          }
        } catch (err) {
          console.error(
            `manual reading failed for run ${run.id}: ${err instanceof Error ? err.message : err}`,
          );
          // A request Claude refuses outright (a picture it can't take, say) would
          // fail the same way every time: that conversation is set aside. Anything
          // else (busy, offline) leaves it unread for the next update, and this
          // update ends here rather than fail its way down the list.
          if (!refusedForGood(err)) {
            counts.failed += 1;
            trouble = true;
            break;
          }
          plan = { kind: "failed" };
        }
      }
      const { data: outcome, error } = await deps.admin.rpc("apply_manual_reading", {
        p_run_id: run.id,
        p_ticket_id: ticket.id,
        p_plan: plan.kind === "failed" ? { kind: "failed" } : planPayload(plan, filing),
      });
      if (error) throw new Error(`Could not file a reading: ${error.message}`);
      if (outcome === "new") counts.written += 1;
      else if (outcome === "updated") counts.added += 1;
      else if (outcome === "suggested") counts.suggested += 1;
      else if (outcome === "failed") counts.failed += 1;
      else counts.nothing += 1;
      counts.waiting = Math.max(0, counts.waiting - 1);
    }
    return trouble
      ? finish(
          "failed",
          "Claude couldn't be reached part-way through. What was read is kept; try again later.",
        )
      : finish("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`manual run ${run.id} failed: ${message}`);
    return finish("failed", "The update couldn't be finished. Try again in a little while.");
  }
}

/** The run's result in a sentence, for the manual's page. */
export function describeRun(counts: Partial<RunCounts>, name: string): string {
  const n = (count: number | undefined, one: string, many: string) =>
    count ? `${count} ${count === 1 ? one : many}` : null;
  const did = [
    n(counts.written, "new topic", "new topics"),
    n(counts.added, "topic added to", "topics added to"),
    n(counts.suggested, "suggested update", "suggested updates"),
  ].filter(Boolean);
  const parts = [
    counts.read
      ? `Read ${counts.read} ${counts.read === 1 ? "conversation" : "conversations"}${did.length ? `: ${did.join(", ")}` : ": nothing new to write down"}.`
      : "Nothing new to read.",
  ];
  if (counts.failed) {
    parts.push(
      `${counts.failed} couldn't be read and ${counts.failed === 1 ? "was" : "were"} left out.`,
    );
  }
  if (counts.stopped === "allowance") {
    parts.push(
      "It stopped because this month's AI allowance is used up. It carries on next month, or sooner on a bigger plan.",
    );
  } else if (counts.stopped === "cap") {
    parts.push(
      `It stopped at this month's limit for the ${name.toLowerCase()}. You can raise it in Settings.`,
    );
  } else if (counts.stopped === "no_sources") {
    parts.push("It hasn't been told which conversations to read yet. Choose them in Settings.");
  } else if (counts.stopped === "off") {
    parts.push("The help desk isn't part of this workspace's plan right now.");
  } else if (counts.waiting) {
    parts.push(
      `${counts.waiting} more ${counts.waiting === 1 ? "is" : "are"} waiting for the next update.`,
    );
  }
  return parts.join(" ");
}
