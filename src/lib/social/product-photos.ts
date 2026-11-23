/**
 * Copying product photos from the shop into a workspace's Assets.
 *
 * The app never fetches an address a person typed. The one thing it does
 * fetch is a product photo whose address the shop itself gave us, and only
 * from the shop platform's own image servers; anything else is refused here.
 */

const PHOTO_HOSTS = new Set(["cdn.shopify.com"]);

/** The address to fetch a product photo from, sized for the library, or null if it isn't one we fetch. */
export function shopPhotoAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!PHOTO_HOSTS.has(url.hostname.toLowerCase())) return null;
  // Big enough for a post, small enough to stay under the library's limit.
  url.searchParams.set("width", "2048");
  return url.toString();
}

const SKIP = new Set(["the", "and", "for", "with", "from", "your", "our", "set", "kit", "pack"]);

/** Tags for a product photo: "product", plus the telling words of its name. */
export function productPhotoTags(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(
      (word) => word.length >= 3 && word.length <= 30 && !SKIP.has(word) && !/^\d+$/.test(word),
    );
  return ["product", ...new Set(words)].slice(0, 6);
}

export const productSourceRef = (provider: string, productId: string) =>
  `${provider}:product:${productId}`;
