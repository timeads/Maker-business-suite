import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { describeMonthRun, runClaimedMonth, type MonthRunDeps } from "./month-run";
import type { MonthPostInput, MonthWriter } from "./month-writer";

/**
 * The worker's path with a made-up database and a made-up writer. Every
 * business, project and caption here is invented.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const BRAND = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RUN = {
  id: "22222222-2222-4222-8222-222222222222",
  tenant_id: TENANT,
  brand_id: BRAND,
  // The first Monday of December 2026 to the day before the first Monday of January.
  window_start: "2026-12-07",
  window_end: "2027-01-03",
  source: "schedule" as const,
};
const now = () => new Date("2026-11-30T15:00:00Z");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

type Row = Record<string, unknown>;

const PLAN = {
  version: 1,
  topics: [
    { id: "rugs", name: "Rugs in progress", about: "", from: "projects" },
    { id: "tips", name: "Tufting tips", about: "Small things that help" },
  ],
  slots: [
    { weekday: 1, time: "10:00", topic: "tips" },
    { weekday: 4, time: "10:00", topic: "rugs" },
  ],
  style_notes: "No exclamation marks.",
  review_days: [{ brand_id: null, week: 1, weekday: 1, lead_days: 7, auto: true }],
};

const asset = (id: string, over: Row = {}): Row => ({
  tenant_id: TENANT,
  id,
  storage_path: `${TENANT}/${id}.jpg`,
  mime_type: "image/jpeg",
  title: "",
  tags: [],
  hidden: false,
  project_id: PROJECT,
  created_at: `2026-11-0${id.length % 9}T10:00:00Z`,
  ...over,
});

function fakeDb(over: { used?: number } = {}) {
  const tables: Record<string, Row[]> = {
    tenants: [{ id: TENANT, name: "Fern & Loop", timezone: "America/New_York" }],
    brands: [
      {
        tenant_id: TENANT,
        id: BRAND,
        name: "Fern & Loop",
        slug: "fern",
        kit_key: "kit",
        is_default: true,
        archived_at: null,
      },
    ],
    subscriptions: [{ tenant_id: TENANT, plan: "growth", status: "active", selected_modules: [] }],
    plan_grants: [],
    usage_events: over.used
      ? [
          {
            tenant_id: TENANT,
            type: "ai_tokens",
            quantity: over.used,
            occurred_at: now().toISOString(),
          },
        ]
      : [],
    configs: [
      { tenant_id: TENANT, module: "social", key: "plan", body: PLAN },
      {
        tenant_id: TENANT,
        module: "social",
        key: "style_notes",
        body: { version: 1, notes: "- Say the size" },
      },
      { tenant_id: TENANT, module: "brand", key: "kit", body: { version: 1, name: "Fern & Loop" } },
      // Another workspace's notes are never read.
      {
        tenant_id: OTHER,
        module: "social",
        key: "style_notes",
        body: { version: 1, notes: "SECRET" },
      },
    ],
    social_posts: [
      {
        tenant_id: TENANT,
        status: "published",
        scheduled_for: "2026-11-20T15:00:00Z",
        planned_for: null,
        brand_id: BRAND,
        asset_id: "used1",
        asset_ids: ["used1"],
        caption: "A rug we finished.",
        published_at: "2026-11-20T15:00:00Z",
      },
      // The second Monday already has a draft for this brand.
      {
        tenant_id: TENANT,
        status: "draft",
        scheduled_for: null,
        planned_for: "2026-12-14T15:00:00Z",
        brand_id: BRAND,
        asset_id: null,
        asset_ids: [],
        caption: "",
        published_at: null,
      },
    ],
    social_projects: [
      {
        tenant_id: TENANT,
        id: PROJECT,
        name: "Moss rug",
        note: "For a reading nook",
        topic: "rugs",
        archived_at: null,
      },
    ],
    social_assets: [
      asset("used1"),
      asset("m1"),
      asset("m22"),
      asset("m333"),
      asset("tip", { project_id: null, tags: ["tufting tips"] }),
      asset("other", { tenant_id: OTHER }),
    ],
    social_post_edits: [
      { tenant_id: TENANT, brand_id: BRAND, before: "So excited!", after: "Off the frame." },
    ],
  };
  const filed: Row[] = [];
  const calls: { fn: string; args: Row }[] = [];
  const builder = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const chain: Record<string, unknown> = {};
    const keep = (test: (row: Row) => boolean) => {
      rows = rows.filter(test);
      return chain;
    };
    chain.select = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.eq = (column: string, value: unknown) =>
      keep((r) => !(column in r) || r[column] === value);
    chain.in = (column: string, values: unknown[]) => keep((r) => values.includes(r[column]));
    chain.is = (column: string, value: unknown) => keep((r) => (r[column] ?? null) === value);
    chain.like = (column: string, pattern: string) =>
      keep((r) => String(r[column]).startsWith(pattern.replace("%", "")));
    chain.gte = (column: string, value: string) =>
      keep((r) => !(column in r) || String(r[column]) >= value);
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
    return chain;
  };
  const admin = {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Row) => {
      calls.push({ fn, args });
      if (fn === "file_social_month_draft") {
        filed.push(args.p_draft as Row);
        return { data: `post-${filed.length}`, error: null };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, calls, filed };
}

function writer(answer: "ok" | "refuse" | "throw" = "ok", tokens = 500) {
  const seen: MonthPostInput[] = [];
  const write: MonthWriter = async (input) => {
    seen.push(input);
    if (answer === "throw") throw new Error("offline");
    if (answer === "refuse") return { ok: false, reason: "declined", tokens };
    return {
      ok: true,
      post: {
        caption: `  Draft ${seen.length} for ${input.project?.name ?? input.topic?.name}  `,
        sees: "",
      },
      tokens,
    };
  };
  return { write, seen };
}

const deps = (
  db: ReturnType<typeof fakeDb>,
  write: MonthWriter,
  alerts: string[] = [],
): MonthRunDeps => ({
  admin: db.admin,
  write,
  now,
  loadPhoto: async () => JPEG,
  alert: async (_tenant, text) => {
    alerts.push(text);
  },
});

const finished = (db: ReturnType<typeof fakeDb>) =>
  db.calls.filter((c) => c.fn === "finish_social_month_run").map((c) => c.args);

describe("a monthly run", () => {
  it("drafts the open times: a carousel from the project's unposted photos, posts from topics", async () => {
    const db = fakeDb();
    const { write, seen } = writer();
    const alerts: string[] = [];
    const outcome = await runClaimedMonth(RUN, deps(db, write, alerts));

    // Mondays 7, 21, 28 December (the 14th is taken); Thursdays 10, 17, 24, 31 December.
    const kinds = db.filed.map((d) => [d.planned_for, d.kind]);
    expect(kinds).toEqual([
      ["2026-12-07T15:00:00.000Z", "topic"],
      ["2026-12-10T15:00:00.000Z", "project"],
      ["2026-12-21T15:00:00.000Z", "topic"],
      ["2026-12-28T15:00:00.000Z", "topic"],
    ]);
    const carousel = db.filed[1];
    // The used photo stays out; the rest go in the order they were added.
    expect(carousel.asset_ids).toEqual(["m1", "m22", "m333"]);
    expect(carousel.project_id).toBe(PROJECT);
    expect(carousel.caption).toBe("Draft 2 for Moss rug");
    // A topic post takes the photo whose tag fits, once.
    expect(db.filed[0].asset_ids).toEqual(["tip"]);
    expect(db.filed[2].asset_ids).toEqual([]);

    // What Claude was told: the brand's notes and edits, never another workspace's.
    expect(seen[0].learned).toBe("- Say the size");
    expect(seen[0].lessons).toEqual([{ before: "So excited!", after: "Off the frame." }]);
    expect(seen[0].houseStyle).toBe("No exclamation marks.");
    expect(seen[0].recent).toEqual(["A rug we finished."]);
    expect(JSON.stringify(seen)).not.toContain("SECRET");
    expect(seen[1].project).toEqual({
      name: "Moss rug",
      note: "For a reading nook",
      photoCount: 3,
    });
    expect(seen[1].photos).toHaveLength(3);

    // Every call metered; the run finished with its counts; one heads-up.
    expect(db.calls.filter((c) => c.fn === "record_usage")).toHaveLength(4);
    expect(finished(db)).toEqual([
      expect.objectContaining({
        p_status: "done",
        p_counts: expect.objectContaining({ drafted: 4, projects: 1, topics: 3, empty: 3 }),
      }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("drafted 4 posts");
    expect(alerts[0]).toContain("nothing goes out until someone approves or schedules it");
    expect(outcome).toContain("done");
  });

  it("never asks to schedule or post anything", async () => {
    const db = fakeDb();
    await runClaimedMonth(RUN, deps(db, writer().write));
    const names = new Set(db.calls.map((c) => c.fn));
    expect([...names].sort()).toEqual([
      "file_social_month_draft",
      "finish_social_month_run",
      "record_usage",
    ]);
    for (const draft of db.filed) {
      expect(Object.keys(draft).sort()).toEqual(
        ["asset_ids", "caption", "kind", "planned_for", "project_id", "topic"].sort(),
      );
    }
  });

  it("stops at the month's AI allowance", async () => {
    const db = fakeDb({ used: 1_000_000 });
    const { write, seen } = writer();
    const alerts: string[] = [];
    await runClaimedMonth(RUN, deps(db, write, alerts));
    expect(seen).toHaveLength(0);
    expect(db.filed).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(finished(db)[0]).toMatchObject({
      p_status: "done",
      p_counts: expect.objectContaining({ stopped: "allowance" }),
    });
  });

  it("files nothing Claude declined, and is marked failed when nothing came of it", async () => {
    const db = fakeDb();
    await runClaimedMonth(RUN, deps(db, writer("refuse").write));
    expect(db.filed).toHaveLength(0);
    expect(finished(db)[0]).toMatchObject({ p_status: "failed" });
  });

  it("ends the run when Claude can't be reached, keeping nothing half-made", async () => {
    const db = fakeDb();
    await runClaimedMonth(RUN, deps(db, writer("throw").write));
    expect(db.filed).toHaveLength(0);
    expect(finished(db)[0]).toMatchObject({
      p_status: "failed",
      p_counts: expect.objectContaining({ failed: 1 }),
    });
  });
});

describe("describeMonthRun", () => {
  it("says what happened in plain words", () => {
    expect(describeMonthRun({ drafted: 5, projects: 2, empty: 1 })).toBe(
      "Drafted 5 posts (2 from projects). 1 project time was left empty: no project had two or more photos that haven't been posted.",
    );
    expect(describeMonthRun({ drafted: 0, stopped: "allowance" })).toBe(
      "Nothing was drafted. It stopped because this month's AI allowance is used up.",
    );
    expect(describeMonthRun({ stopped: "no_times" })).toContain("no open posting times");
  });
});
