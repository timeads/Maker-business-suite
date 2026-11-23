import { describe, expect, it } from "vitest";
import { productPhotoTags, productSourceRef, shopPhotoAddress } from "./product-photos";

describe("product photos from the shop", () => {
  it("only ever fetches from the shop platform's own image servers", () => {
    expect(shopPhotoAddress("https://cdn.shopify.com/s/files/1/rug.jpg?v=3")).toBe(
      "https://cdn.shopify.com/s/files/1/rug.jpg?v=3&width=2048",
    );
    for (const bad of [
      "http://cdn.shopify.com/a.jpg",
      "https://cdn.shopify.com.evil.example/a.jpg",
      "https://evil.example/cdn.shopify.com/a.jpg",
      "https://user:pass@cdn.shopify.com/a.jpg",
      "https://cdn.shopify.com:8443/a.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/a.jpg",
      "file:///etc/passwd",
      "not a url",
      "",
      null,
    ]) {
      expect(shopPhotoAddress(bad), String(bad)).toBeNull();
    }
  });

  it("tags a photo with the telling words of the product's name", () => {
    expect(productPhotoTags("The Hand-Tufted Wool Rug (Large) 2026")).toEqual([
      "product",
      "hand",
      "tufted",
      "wool",
      "rug",
      "large",
    ]);
    expect(productPhotoTags("")).toEqual(["product"]);
    expect(productSourceRef("shopify", "812")).toBe("shopify:product:812");
  });
});
