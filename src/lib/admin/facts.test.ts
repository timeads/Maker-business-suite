import { describe, expect, it } from "vitest";
import {
  attentionReasons,
  auditWords,
  endOfDayUtc,
  filterAndSort,
  planWords,
  rowEntitlements,
  workspaceRowSchema,
  type WorkspaceRow,
} from "./facts";

const now = new Date("2026-12-10T12:00:00Z");

function row(overrides: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    tenant_id: "11111111-1111-4111-8111-111111111111",
    name: "Alice Rugs",
    slug: "alice-rugs",
    created_at: "2026-11-01T00:00:00Z",
    owner_email: "alice@a.test",
    member_count: 2,
    plan: "growth",
    status: "active",
    trial_end: null,
    current_period_end: "2026-12-21T00:00:00Z",
    cancel_at_period_end: false,
    grant_plan: null,
    grant_ends_at: null,
    connections: [{ provider: "shopify", health: "active" }],
    last_synced_at: "2026-12-10T11:00:00Z",
    failed_jobs_7d: 0,
    ai_tokens_month: 1200,
    ...overrides,
  };
}

describe("planWords", () => {
  const words = (r: WorkspaceRow) => planWords(rowEntitlements(r, now), r);

  it("names each billing state", () => {
    expect(words(row())).toMatchObject({ plan: "Growth", word: "Active", tone: "good" });
    expect(words(row({ status: "trialing", trial_end: "2026-12-14T00:00:00Z" }))).toMatchObject({
      word: "Trialing",
      date: { label: "trial ends", at: "2026-12-14T00:00:00Z" },
    });
    expect(words(row({ status: "past_due" }))).toMatchObject({ word: "Past due", tone: "bad" });
    expect(words(row({ status: "canceled" }))).toMatchObject({ plan: "Growth", word: "Ended" });
    expect(words(row({ plan: null, status: null }))).toMatchObject({ word: "No plan" });
  });

  it("shows a running grant as internal, and an ended one as whatever Stripe says", () => {
    expect(
      words(
        row({ status: "past_due", grant_plan: "studio", grant_ends_at: "2027-01-01T00:00:00Z" }),
      ),
    ).toMatchObject({
      plan: "Studio",
      word: "Internal",
      date: { label: "until", at: "2027-01-01T00:00:00Z" },
    });
    expect(
      words(
        row({ status: "past_due", grant_plan: "studio", grant_ends_at: "2026-12-01T00:00:00Z" }),
      ),
    ).toMatchObject({ plan: "Growth", word: "Past due" });
  });
});

describe("attention and ordering", () => {
  const calm = row();
  const failing = row({
    tenant_id: "22222222-2222-4222-8222-222222222222",
    name: "Bob Pottery",
    slug: "bob-pottery",
    owner_email: "bob@b.test",
    created_at: "2026-10-01T00:00:00Z",
    failed_jobs_7d: 3,
    connections: [{ provider: "quickbooks", health: "needs reconnect" }],
  });
  const late = row({
    tenant_id: "33333333-3333-4333-8333-333333333333",
    name: "Cara Candles",
    slug: "cara",
    owner_email: null,
    created_at: "2026-09-01T00:00:00Z",
    status: "past_due",
  });

  it("says why in plain words, and nothing when all is well", () => {
    expect(attentionReasons(calm, now)).toEqual([]);
    expect(attentionReasons(failing, now)).toEqual([
      "quickbooks needs reconnecting",
      "3 failed jobs this week",
    ]);
    expect(attentionReasons(late, now)).toEqual(["Payment is past due"]);
    // An internal plan sets a late payment aside.
    expect(attentionReasons({ ...late, grant_plan: "growth" }, now)).toEqual([]);
  });

  it("puts newest first, or the ones needing a look first", () => {
    const all = [late, calm, failing];
    expect(filterAndSort(all, "", "newest", now).map((r) => r.slug)).toEqual([
      "alice-rugs",
      "bob-pottery",
      "cara",
    ]);
    expect(filterAndSort(all, "", "attention", now).map((r) => r.slug)).toEqual([
      "bob-pottery",
      "cara",
      "alice-rugs",
    ]);
  });

  it("searches name, slug and owner's email", () => {
    const all = [late, calm, failing];
    expect(filterAndSort(all, " POTTERY ", "newest", now).map((r) => r.slug)).toEqual([
      "bob-pottery",
    ]);
    expect(filterAndSort(all, "cara", "newest", now)).toHaveLength(1);
    expect(filterAndSort(all, "alice@a", "newest", now)).toHaveLength(1);
    expect(filterAndSort(all, "nobody", "newest", now)).toEqual([]);
  });
});

describe("parsing what the database hands back", () => {
  it("drops anything that isn't a listed fact", () => {
    const parsed = workspaceRowSchema.parse({ ...row(), shopper_name: "Someone" });
    expect(parsed).not.toHaveProperty("shopper_name");
  });
});

describe("endOfDayUtc", () => {
  it("means through the end of the day", () => {
    expect(endOfDayUtc("2027-03-31")).toBe("2027-03-31T23:59:59.000Z");
  });
  it("refuses things that aren't a real day", () => {
    expect(endOfDayUtc("2027-02-30")).toBeNull();
    expect(endOfDayUtc("31/03/2027")).toBeNull();
    expect(endOfDayUtc("")).toBeNull();
  });
});

describe("auditWords", () => {
  it("reads as a sentence", () => {
    expect(auditWords("plan_grant.set", { plan: "growth", ends_at: null })).toBe(
      "Set an internal plan: Growth, no end date",
    );
    expect(auditWords("plan_grant.set", { plan: "studio", ends_at: "2027-01-01T23:59:59Z" })).toBe(
      "Set an internal plan: Studio until Jan 1, 2027",
    );
    expect(auditWords("sync.requeued", { provider: "shopify", queued: true })).toBe(
      "Asked for a fresh sync for shopify",
    );
    expect(auditWords("plan_grant.ended", {})).toBe("Ended the internal plan");
  });
});
