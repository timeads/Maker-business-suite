import { describe, expect, it } from "vitest";
import { placeImages } from "./worker";

describe("each place's photos", () => {
  const copies = new Map([
    ["c1", { storage_path: "w/c1.jpg", fitted_from: "a", fitted_for: "instagram" }],
    ["c2", { storage_path: "w/c2.jpg", fitted_from: "b", fitted_for: "instagram_story" }],
  ]);

  it("uses a place's copies in the post's order, and the photo itself where it fits", () => {
    expect(
      placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram: ["c1", "b"] }, copies),
    ).toEqual({ instagram: ["w/c1.jpg", "w/b.jpg"] });
  });

  it("ignores copies that aren't that photo's, for that place, or out of step", () => {
    expect(
      placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram: ["c2", "b"] }, copies),
    ).toEqual({});
    expect(placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram: ["c1"] }, copies)).toEqual(
      {},
    );
    expect(
      placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram_story: ["c1", "b"] }, copies),
    ).toEqual({});
    expect(placeImages(["a", "b"], ["w/a.jpg"], { instagram: ["c1", "b"] }, copies)).toEqual({});
  });
});
