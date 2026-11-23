import { describe, expect, it } from "vitest";
import { matchPhotos, matchWords, pickLogoAsset, pickPhoto, type TaggedAsset } from "./photo-match";

const asset = (
  id: string,
  title: string,
  tags: string[],
  mimeType = "image/jpeg",
): TaggedAsset => ({
  id,
  title,
  tags,
  mimeType,
});

// Newest first, as the library lists them.
const library = [
  asset("clip", "Workshop clip", ["workshop"], "video/mp4"),
  asset("logo", "Our logo", ["logo", "workshop"]),
  asset("logo-light", "Logo, white", ["logo-light"]),
  asset("ws-new", "IMG_2041", ["workshop", "studio"]),
  asset("ws-old", "Saturday class", ["workshop"]),
  asset("yarn", "Autumn yarn wall", ["yarn", "autumn sale"]),
  asset("slide", "Workshop poster", ["designed", "banner"]),
  asset("rug", "Blue rug", []),
];

describe("matching photos to words by their tags", () => {
  it("reads the words that matter, without the small ones or a plain plural", () => {
    expect([...matchWords("Our new Workshops are on this Saturday!")].sort()).toEqual([
      "saturday",
      "workshop",
    ]);
    expect(matchWords("a to the of").size).toBe(0);
  });

  it("picks by tag first, newest first, and says why", () => {
    const found = matchPhotos(library, "Two places left in the weekend workshops");
    expect(found.map((m) => m.asset.id)).toEqual(["ws-new", "ws-old", "slide"]);
    expect(found[0].reason).toBe("matched your tag: workshop");
    expect(found[0].tag).toBe("workshop");
    // A name counts for less than a tag, and says so.
    expect(found[2].reason).toBe("matched its name: Workshop poster");
    expect(found[2].score).toBeLessThan(found[0].score);
  });

  it("never offers a video or a logo, whatever they are tagged", () => {
    const ids = matchPhotos(library, "workshop logo studio", { limit: 10 }).map((m) => m.asset.id);
    expect(ids).not.toContain("clip");
    expect(ids).not.toContain("logo");
    expect(ids).not.toContain("logo-light");
  });

  it("needs every word of a tag, and ignores the tags the library adds itself", () => {
    expect(pickPhoto(library, "Our autumn update")).toMatchObject({
      asset: { id: "yarn" },
      reason: "matched its name: Autumn yarn wall",
    });
    expect(pickPhoto(library, "The autumn sale starts Friday")?.tag).toBe("autumn sale");
    expect(matchPhotos(library, "a designed banner")).toEqual([]);
  });

  it("gives one photo at most, skips ones already used, and gives none when nothing fits", () => {
    expect(pickPhoto(library, "workshop")?.asset.id).toBe("ws-new");
    expect(pickPhoto(library, "workshop", ["ws-new"])?.asset.id).toBe("ws-old");
    expect(pickPhoto(library, "workshop", ["ws-new", "ws-old", "slide"])).toBeNull();
    expect(pickPhoto(library, "something about glazing pots")).toBeNull();
    expect(pickPhoto(library, "")).toBeNull();
    expect(pickPhoto([], "workshop")).toBeNull();
  });

  it("finds the logo by its tag, and the light one for dark backgrounds", () => {
    expect(pickLogoAsset(library)?.id).toBe("logo");
    expect(pickLogoAsset(library, true)?.id).toBe("logo-light");
    const onlyDark = library.filter((a) => a.id !== "logo-light");
    expect(pickLogoAsset(onlyDark, true)?.id).toBe("logo");
    expect(pickLogoAsset(library.filter((a) => !a.id.startsWith("logo")))).toBeNull();
    // A video tagged as the logo is not a logo.
    expect(pickLogoAsset([asset("v", "", ["logo"], "video/mp4")])).toBeNull();
  });
});
