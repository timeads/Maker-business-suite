import { afterEach, describe, expect, it } from "vitest";
import {
  PLACES,
  PLACE_RULES,
  checkPlace,
  hashtagCount,
  placeRuleError,
  placesOf,
  problemWords,
} from "./networks";
import {
  DEFAULT_TIKTOK_OPTIONS,
  checkTikTokOptions,
  privacyChoices,
  readCreatorChoices,
  tiktokAudited,
  tiktokOptionsFor,
  tiktokPostInfo,
} from "./tiktok-options";

describe("each network's rules", () => {
  it("every place belongs to a network and has words for people", () => {
    for (const place of PLACES) {
      expect(PLACE_RULES[place].label).toBeTruthy();
      expect(placesOf(PLACE_RULES[place].network)).toContain(place);
    }
    expect(placesOf("instagram")).toEqual(["instagram", "instagram_story"]);
  });

  it("TikTok takes a video and nothing else", () => {
    expect(checkPlace("tiktok", { words: "Hi", photos: 0, video: true })).toEqual([]);
    expect(
      checkPlace("tiktok", { words: "Hi", photos: 0, video: false }).map((p) => p.kind),
    ).toEqual(["needs_video"]);
    expect(
      checkPlace("tiktok", { words: "Hi", photos: 2, video: false }).map((p) => p.kind),
    ).toEqual(["needs_video", "too_many_photos"]);
  });

  it("LinkedIn takes words alone, photos or a video, and longer captions", () => {
    expect(checkPlace("linkedin", { words: "Just words", photos: 0, video: false })).toEqual([]);
    expect(checkPlace("linkedin", { words: "x".repeat(3000), photos: 3, video: false })).toEqual(
      [],
    );
    expect(
      checkPlace("linkedin", { words: "x".repeat(3001), photos: 0, video: false })[0],
    ).toMatchObject({
      kind: "caption_long",
      max: 3000,
    });
  });

  it("Instagram counts hashtags; an emoji is one character", () => {
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(hashtagCount(tags)).toBe(31);
    expect(hashtagCount("price#1 and #rugs")).toBe(1);
    expect(checkPlace("instagram", { words: tags, photos: 1, video: false })[0].kind).toBe(
      "hashtags",
    );
    expect(checkPlace("facebook", { words: tags, photos: 0, video: false })).toEqual([]);
    expect(checkPlace("instagram", { words: "🧶".repeat(2200), photos: 1, video: false })).toEqual(
      [],
    );
  });

  it("the database's refusals come back as the same plain words", () => {
    expect(placeRuleError("ERROR: place_rule:needs_video:tiktok")).toBe(
      problemWords({ kind: "needs_video", place: "tiktok" }),
    );
    expect(placeRuleError("place_rule:too_many_photos:tiktok")).toMatch(
      /takes a video, not photos/,
    );
    expect(placeRuleError("place_rule:no_account:linkedin")).toMatch(/Tick a LinkedIn account/);
    expect(placeRuleError("place_rule:needs_video:pinterest")).toBeNull();
    expect(placeRuleError("something else")).toBeNull();
  });
});

describe("TikTok's choices", () => {
  afterEach(() => {
    delete process.env.TIKTOK_APP_AUDITED;
  });

  it("start safe: nobody chosen, everything off", () => {
    expect(DEFAULT_TIKTOK_OPTIONS).toEqual({
      privacy_level: null,
      allow_comment: false,
      allow_duet: false,
      allow_stitch: false,
      brand_organic: false,
      brand_content: false,
    });
    expect(tiktokOptionsFor({ a: { privacy_level: "BOGUS" } }, "a")).toEqual(
      DEFAULT_TIKTOK_OPTIONS,
    );
    expect(tiktokOptionsFor(null, "a")).toEqual(DEFAULT_TIKTOK_OPTIONS);
  });

  it("an app TikTok hasn't reviewed can only post privately, and says so", () => {
    expect(tiktokAudited()).toBe(false);
    const creator = readCreatorChoices({
      privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY", "NONSENSE"],
      comment_disabled: true,
      max_video_post_duration_sec: 600,
    });
    expect(creator.privacyOptions).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
    expect(privacyChoices(creator, false)).toEqual(["SELF_ONLY"]);
    expect(privacyChoices(creator, true)).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
    const everyone = { ...DEFAULT_TIKTOK_OPTIONS, privacy_level: "PUBLIC_TO_EVERYONE" as const };
    expect(checkTikTokOptions(everyone, creator, false)).toMatch(/until TikTok has reviewed it/);
    expect(checkTikTokOptions(everyone, creator, true)).toBeNull();
    expect(checkTikTokOptions(DEFAULT_TIKTOK_OPTIONS, creator, true)).toMatch(/Choose who can see/);
    expect(
      checkTikTokOptions(
        { ...DEFAULT_TIKTOK_OPTIONS, privacy_level: "SELF_ONLY", brand_content: true },
        creator,
        true,
      ),
    ).toMatch(/branded content to be private/);
  });

  it("whatever the creator switched off in TikTok stays off", () => {
    const info = tiktokPostInfo(
      {
        ...DEFAULT_TIKTOK_OPTIONS,
        privacy_level: "SELF_ONLY",
        allow_comment: true,
        allow_duet: true,
      },
      readCreatorChoices({ comment_disabled: true }),
      "Words",
    );
    expect(info).toMatchObject({
      title: "Words",
      privacy_level: "SELF_ONLY",
      disable_comment: true,
      disable_duet: false,
      disable_stitch: true,
    });
  });
});
