import { describe, expect, it } from "vitest";
import { requiredItems } from "../setup/items";
import { scheduleExplained, targetExplained } from "./explain";
import { SOCIAL_STEPS, socialSetupItems, type SocialSetupFacts } from "./setup";

/** A workspace with nothing left to do. */
const done = (more: Partial<SocialSetupFacts> = {}): SocialSetupFacts => ({
  kitSaved: true,
  meta: { status: "active", canPostFacebook: true, canPostInstagram: true },
  metaAccounts: 2,
  otherAccounts: 0,
  needsLogin: [],
  tiktok: { offered: false, connected: false },
  linkedin: { offered: true, connected: true },
  plan: { topics: 3, monthlyRunOn: true },
  review: { saved: true },
  links: { published: true },
  logo: true,
  ...more,
});
const ids = (facts: SocialSetupFacts) => socialSetupItems(facts).map((item) => item.id);

describe("socialSetupItems", () => {
  it("has nothing to say when everything is in place", () => {
    expect(socialSetupItems(done())).toEqual([]);
  });

  it("asks for the main brand's kit", () => {
    expect(ids(done({ kitSaved: false }))).toEqual(["brand.kit"]);
  });

  it("asks for somewhere to post, one thing at a time", () => {
    expect(ids(done({ meta: null, metaAccounts: 0 }))).toEqual(["accounts.connect"]);
    // TikTok or LinkedIn already carries the posts: Facebook isn't needed.
    expect(ids(done({ meta: null, metaAccounts: 0, otherAccounts: 1 }))).toEqual([]);
    expect(
      ids(
        done({
          meta: { status: "needs_reconnect", canPostFacebook: true, canPostInstagram: true },
        }),
      ),
    ).toEqual(["accounts.reconnect"]);
    expect(
      ids(done({ meta: { status: "active", canPostFacebook: false, canPostInstagram: false } })),
    ).toEqual(["accounts.posting"]);
    expect(ids(done({ metaAccounts: 0 }))).toEqual(["accounts.choose"]);
  });

  it("says when an account's login ran out, as required", () => {
    const item = socialSetupItems(
      done({
        needsLogin: [
          { id: "b", name: "@studio" },
          { id: "a", name: "My page" },
        ],
      }),
    )[0];
    expect(item).toMatchObject({
      id: "accounts.login",
      title: "2 accounts need logging in again",
      facts: "a,b",
      names: ["@studio", "My page"],
    });
    expect(item.optional).toBeUndefined();
  });

  it("offers TikTok and LinkedIn only where their keys are set", () => {
    expect(ids(done({ tiktok: { offered: true, connected: false } }))).toEqual(["accounts.tiktok"]);
    expect(ids(done({ linkedin: { offered: false, connected: false } }))).toEqual([]);
  });

  it("offers the plan first, then explains the monthly run without switching it on", () => {
    expect(ids(done({ plan: { topics: 0, monthlyRunOn: false } }))).toEqual(["plan.topics"]);
    const month = socialSetupItems(done({ plan: { topics: 2, monthlyRunOn: false } }))[0];
    expect(month).toMatchObject({ id: "plan.month", to: "social/plan#month", optional: true });
  });

  it("offers the rest as optional, never on the card", () => {
    const facts = done({
      tiktok: { offered: true, connected: false },
      plan: { topics: 0, monthlyRunOn: false },
      review: { saved: false },
      links: { published: false },
      logo: false,
    });
    expect(ids(facts)).toEqual(["accounts.tiktok", "plan.topics", "review", "links", "logo"]);
    expect(requiredItems(socialSetupItems(facts))).toEqual([]);
    // Not looked for: never asked.
    expect(ids(done({ logo: null }))).toEqual([]);
  });

  it("puts every item in a step that exists", () => {
    const steps = new Set(SOCIAL_STEPS.map((s) => s.id));
    const all = socialSetupItems(
      done({
        kitSaved: false,
        meta: null,
        metaAccounts: 0,
        needsLogin: [{ id: "a", name: "A" }],
        review: { saved: false },
        links: { published: false },
        logo: false,
      }),
    );
    for (const item of all) expect(steps.has(item.step)).toBe(true);
  });
});

describe("Social explanations", () => {
  const post = (more: Partial<Parameters<typeof scheduleExplained>[0]> = {}) => ({
    places: ["facebook", "instagram"] as ("facebook" | "instagram" | "tiktok")[],
    wordsFor: () => "Fresh from the studio",
    photos: [{ width: 1080, height: 1080 }],
    video: false,
    needsApproval: false,
    ...more,
  });

  it("says nothing stands in the way when it fits", () => {
    expect(scheduleExplained(post())).toEqual([
      "Nothing stands in the way: pick a time and schedule it.",
    ]);
  });

  it("names each place's rule that isn't met", () => {
    expect(scheduleExplained(post({ photos: [] }))).toEqual([
      "Instagram needs a photo or a video.",
    ]);
    expect(scheduleExplained(post({ places: ["tiktok"] }))[0]).toMatch(/TikTok needs a video/);
    expect(scheduleExplained(post({ places: [] }))[0]).toMatch(/Tick at least one place/);
  });

  it("explains a photo Instagram won't take as it is, and one not yet read", () => {
    expect(scheduleExplained(post({ photos: [{ width: 1000, height: 2000 }] }))[0]).toMatch(
      /The photo is taller than Instagram takes \(between 4:5 and 1.91:1\), so a copy cropped/,
    );
    expect(
      scheduleExplained(
        post({
          photos: [
            { width: 1080, height: 1080 },
            { width: null, height: null },
          ],
        }),
      )[0],
    ).toMatch(/Photo 2's size hasn't been read/);
  });

  it("says when approval is needed first", () => {
    expect(scheduleExplained(post({ needsApproval: true }))).toEqual([
      expect.stringMatching(/approves posts before they go out/),
    ]);
  });

  it("explains each target's state and what to do", () => {
    expect(targetExplained({ pending: "x" }, "Instagram")).toMatch(/still preparing/);
    expect(targetExplained({ unsure: "x" }, "Facebook")).toMatch(/say which/);
    expect(targetExplained({ error: "No" }, "TikTok")).toMatch(/only the places that didn't go/);
    expect(targetExplained({ id: "1" }, "Facebook")).toMatch(/never sent there again/);
    expect(targetExplained({ id: "1", checked_by: "u" }, "Facebook")).toMatch(/checked/);
    expect(targetExplained(undefined, "Facebook")).toMatch(/Waiting/);
  });
});
