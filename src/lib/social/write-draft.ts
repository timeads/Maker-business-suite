import type { BrandKit } from "../design/brands";
import type { SlideDesign } from "../design/slide-design";
import { spread } from "./month";
import {
  MAX_PHOTO_BYTES,
  MAX_SHOWN,
  PHOTO_TYPES,
  tidyCaption,
  type MonthPostInput,
  type MonthWriter,
  type PhotoType,
} from "./month-writer";
import {
  DEFAULT_SLIDES,
  designWords,
  line,
  offerPhotos,
  tidySlides,
  type SlidesWriter,
} from "./slide-writer";

/**
 * One draft written by Claude, the same way wherever it is asked for: the
 * monthly run, "Draft from this project", "Write it again", and slides from
 * the composer or "Draft the month". Words alone (`writeMonthPost`, the
 * post's photos shown) or a designed carousel (`writeSlides`, a few of the
 * business's own photos offered by reference and checked by `tidySlides`).
 * Claude's answer is only ever data for the tidy step; what comes back is a
 * draft for the caller to file. Nothing here saves, schedules or posts.
 */

export type DraftAsset = {
  id: string;
  storage_path: string;
  mime_type: string;
  title: string | null;
  tags: string[] | null;
};

export type WriteDraftInput = {
  /** Who the business is, its voice and what the post is about. */
  about: Omit<MonthPostInput, "photos">;
  makes: "caption" | "slides";
  /** The brand's kit as the slides draw it. Without one, slides become a caption. */
  kit: BrandKit | null;
  /** For words alone: the post's photos. For slides: the photos offered to picture. */
  assets: DraftAsset[];
  slideCount?: number;
  /** What a person asked for, when they typed it. */
  brief?: string;
};

export type WriteDraftDeps = {
  write: MonthWriter;
  writeSlides?: SlidesWriter;
  /** A stored photo's bytes by its storage path. Null when it can't be read. */
  loadPhoto: (path: string) => Promise<Uint8Array | null>;
  /** A stored file's public address. */
  assetUrl: (path: string) => string;
  /** The public address of the workspace's own folder. */
  home: string;
  logos?: { dark?: string | null; light?: string | null };
};

export type Drafted = {
  caption: string;
  /** What the photos show, in a sentence ("" when none were shown). */
  photos_show: string;
  /** Photos on the post itself. */
  asset_ids: string[];
  /** Only for slides: the design, and the library photos it pictures. */
  slides?: SlideDesign;
  pictured_ids?: string[];
  /** Only for slides: facts nobody gave, for the person to fill in. */
  missing?: string[];
};

export type WrittenDraft = { tokens: number; draft: Drafted | null; declined: boolean };

/**
 * Up to four of the photos, spread across them, that can be shown to Claude,
 * each with its reference when the photos are offered for slides.
 */
export async function shownPhotos(
  assets: { storage_path: string; mime_type: string; ref?: string }[],
  load: (path: string) => Promise<Uint8Array | null>,
): Promise<MonthPostInput["photos"]> {
  const out: MonthPostInput["photos"] = [];
  for (const asset of spread(assets, MAX_SHOWN)) {
    if (!(PHOTO_TYPES as readonly string[]).includes(asset.mime_type)) continue;
    const bytes = await load(asset.storage_path).catch(() => null);
    if (!bytes || bytes.byteLength > MAX_PHOTO_BYTES) continue;
    out.push({
      type: asset.mime_type as PhotoType,
      base64: Buffer.from(bytes).toString("base64"),
      ...(asset.ref ? { ref: asset.ref } : {}),
    });
  }
  return out;
}

/** Whether this draft will be slides: asked for, with a kit and a writer for them. */
export const writesSlides = (input: Pick<WriteDraftInput, "makes" | "kit">, deps: WriteDraftDeps) =>
  input.makes === "slides" && input.kit !== null && Boolean(deps.writeSlides);

/** Asks Claude for one draft and checks the answer. Throws only when Claude can't be reached. */
export async function writeDraft(
  input: WriteDraftInput,
  deps: WriteDraftDeps,
): Promise<WrittenDraft> {
  if (writesSlides(input, deps) && input.kit && deps.writeSlides) {
    const { offered, files } = offerPhotos(
      input.assets.map((asset) => ({
        id: asset.id,
        url: deps.assetUrl(asset.storage_path),
        title: asset.title ?? "",
        tags: asset.tags ?? [],
      })),
    );
    const result = await deps.writeSlides({
      ...input.about,
      photos: await shownPhotos(
        input.assets.slice(0, files.length).map((asset, index) => ({
          ...asset,
          ref: files[index].ref,
        })),
        deps.loadPhoto,
      ),
      design: designWords(input.kit),
      offered,
      slideCount: input.slideCount ?? DEFAULT_SLIDES,
      ...(input.brief ? { brief: input.brief } : {}),
    });
    if (!result.ok) {
      return { tokens: result.tokens, draft: null, declined: result.reason === "declined" };
    }
    const tidy = tidySlides(result.draft, {
      kit: input.kit,
      offered: files,
      home: deps.home,
      logos: deps.logos,
    });
    return {
      tokens: result.tokens,
      declined: false,
      draft: tidy
        ? {
            caption: tidy.caption,
            photos_show: tidy.sees,
            asset_ids: [],
            slides: tidy.design,
            pictured_ids: tidy.pictured,
            missing: tidy.missing,
          }
        : null,
    };
  }
  const result = await deps.write({
    ...input.about,
    photos: await shownPhotos(input.assets, deps.loadPhoto),
  });
  if (!result.ok) {
    return { tokens: result.tokens, draft: null, declined: result.reason === "declined" };
  }
  const caption = tidyCaption(result.post.caption);
  return {
    tokens: result.tokens,
    declined: false,
    draft: caption
      ? {
          caption,
          photos_show: input.assets.length ? line(result.post.sees, 400) : "",
          asset_ids: input.assets.map((asset) => asset.id),
        }
      : null,
  };
}

/** What earlier drafts of each project said its photos showed, newest first. */
export function earlierReadings(
  posts: { project_id?: string | null; photos_show?: string | null }[],
): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  for (const post of posts) {
    const sentence = (post.photos_show ?? "").trim();
    if (!post.project_id || !sentence) continue;
    const list = seen.get(post.project_id) ?? [];
    if (list.length < 3 && !list.includes(sentence)) list.push(sentence);
    seen.set(post.project_id, list);
  }
  return seen;
}
