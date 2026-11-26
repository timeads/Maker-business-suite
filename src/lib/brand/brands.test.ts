import { describe, expect, it } from "vitest";
import { findConfig } from "../assistant/registry";
import { brandKitKey, isKitKey, pickBrand, sortBrands } from "./brands";

const brand = (id: string, extra: Partial<{ is_default: boolean; archived_at: string }> = {}) => ({
  id,
  name: id,
  is_default: false,
  archived_at: null as string | null,
  ...extra,
});

describe("brands", () => {
  const id = "0b9c3c5e-5a52-4b38-9df0-5c3c8ac0f1a2";

  it("a further brand's kit lives under its own key; the first keeps 'kit'", () => {
    expect(brandKitKey(id)).toBe(`kit-${id}`);
    expect(isKitKey("kit")).toBe(true);
    expect(isKitKey(`kit-${id}`)).toBe(true);
    expect(isKitKey("appearance")).toBe(false);
    expect(isKitKey("kit-../../x")).toBe(false);
  });

  it("picks the named brand, else the main one, else the first live one", () => {
    const all = [
      brand("a", { archived_at: "2026-01-01" }),
      brand("b"),
      brand("c", { is_default: true }),
    ];
    expect(pickBrand(all, "b")?.id).toBe("b");
    expect(pickBrand(all, "nope")?.id).toBe("c");
    expect(pickBrand(all)?.id).toBe("c");
    expect(pickBrand([brand("a", { archived_at: "2026-01-01" }), brand("b")])?.id).toBe("b");
    expect(pickBrand([])).toBeNull();
  });

  it("lists the main brand first and the put-away ones last", () => {
    const sorted = sortBrands([
      brand("zed", { archived_at: "2026-01-01" }),
      brand("bee"),
      brand("ant"),
      brand("main", { is_default: true }),
    ]);
    expect(sorted.map((b) => b.id)).toEqual(["main", "ant", "bee", "zed"]);
  });

  it("the assistant can propose a change to any brand's kit, validated the same way", () => {
    const entry = findConfig("brand", `kit-${id}`);
    expect(entry?.key).toBe(`kit-${id}`);
    expect(entry?.schema).toBe(findConfig("brand", "kit")?.schema);
    expect(findConfig("brand", "kit-nonsense")).toBeNull();
  });
});
