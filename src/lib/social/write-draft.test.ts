import { describe, expect, it } from "vitest";
import { brandKitSchema, toDesignKit } from "../brand/kit";
import type { MonthWriter } from "./month-writer";
import type { SlidesWriter } from "./slide-writer";
import { earlierReadings, writeDraft, type WriteDraftDeps } from "./write-draft";

// Everything here is invented.

const HOME = "https://files.test/social/t1/";
const kit = toDesignKit(
  brandKitSchema.parse({
    version: 1,
    name: "Fern & Loop",
    colors: [
      { name: "moss", hex: "#2f4a3a" },
      { name: "cream", hex: "#f4efe6" },
    ],
  }),
);
const about = {
  business: "Fern & Loop",
  brand: "",
  houseStyle: "",
  learned: "",
  lessons: [],
  recent: [],
  topic: { name: "Tips", about: "" },
  project: null,
};
const asset = (id: string) => ({
  id,
  storage_path: `t1/${id}.jpg`,
  mime_type: "image/jpeg",
  title: "",
  tags: [],
});

const deps = (over: Partial<WriteDraftDeps> = {}): WriteDraftDeps => ({
  write: async () => ({
    ok: true,
    post: { caption: "  Words.  ", sees: "A rug." },
    tokens: 10,
  }),
  loadPhoto: async () => new Uint8Array([0xff, 0xd8, 0xff]),
  assetUrl: (path) => `https://files.test/social/${path}`,
  home: HOME,
  ...over,
});

describe("writeDraft", () => {
  it("writes words for the post's own photos", async () => {
    const out = await writeDraft(
      { about, makes: "caption", kit, assets: [asset("a"), asset("b")] },
      deps(),
    );
    expect(out).toEqual({
      tokens: 10,
      declined: false,
      draft: { caption: "Words.", photos_show: "A rug.", asset_ids: ["a", "b"] },
    });
  });

  it("writes words when slides are asked for but there is no kit or no slides writer", async () => {
    let slides = 0;
    const writeSlides: SlidesWriter = async () => {
      slides += 1;
      return { ok: false, reason: "unusable", tokens: 0 };
    };
    await writeDraft({ about, makes: "slides", kit: null, assets: [] }, deps({ writeSlides }));
    await writeDraft({ about, makes: "slides", kit, assets: [] }, deps());
    expect(slides).toBe(0);
  });

  it("designs slides over the photos offered, checked by the kit", async () => {
    const writeSlides: SlidesWriter = async (input) => {
      expect(input.offered.map((p) => p.ref)).toEqual(["P1"]);
      expect(input.photos[0].ref).toBe("P1");
      return {
        ok: true,
        tokens: 40,
        draft: {
          caption: "Slides.",
          sees: "",
          missing: ["The date"],
          slides: [
            {
              layout: "photo",
              color: "moss",
              kicker: "",
              headline: "Hello",
              body: "",
              footer: "",
              badge: "",
              accent: "",
              photos: ["P1"],
            },
          ],
        },
      };
    };
    const out = await writeDraft(
      { about, makes: "slides", kit, assets: [asset("a")], brief: "Tips" },
      deps({ writeSlides }),
    );
    expect(out.draft?.slides?.slides).toHaveLength(1);
    expect(out.draft?.pictured_ids).toEqual(["a"]);
    expect(out.draft?.asset_ids).toEqual([]);
    expect(out.draft?.missing).toEqual(["The date"]);
  });

  it("says when Claude declined, and gives no draft", async () => {
    const write: MonthWriter = async () => ({ ok: false, reason: "declined", tokens: 3 });
    expect(await writeDraft({ about, makes: "caption", kit, assets: [] }, deps({ write }))).toEqual(
      { tokens: 3, draft: null, declined: true },
    );
  });
});

describe("earlierReadings", () => {
  it("keeps three sentences per project at most, newest first, without repeats", () => {
    const map = earlierReadings([
      { project_id: "p", photos_show: "Four" },
      { project_id: "p", photos_show: "Four" },
      { project_id: "p", photos_show: "Three" },
      { project_id: "p", photos_show: "  " },
      { project_id: "p", photos_show: "Two" },
      { project_id: "p", photos_show: "One" },
      { project_id: null, photos_show: "Loose" },
    ]);
    expect(map.get("p")).toEqual(["Four", "Three", "Two"]);
    expect(map.size).toBe(1);
  });
});
