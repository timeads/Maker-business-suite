import type { BrandKit, LayoutId } from "../design/brands";
import { schemeFor } from "../design/brands";
import {
  FORMATS,
  newId,
  normalizeDesign,
  type Slide,
  type SlideDesign,
  type SlideFormat,
} from "../design/slide-design";
import { buildSlide, contentOf, type SlideContent } from "../design/slide-layouts";

/**
 * Designed pictures in a workspace's own brand. The design engine takes a kit wherever it takes
 * a brand, so everything here passes the workspace's kit (from `toDesignKit`) along: the words,
 * photos and layout stay, the colours and type are the workspace's.
 */

type Words = Pick<SlideContent, "kicker" | "headline" | "body" | "footer" | "badge" | "accent">;

/** Tags the library gives its own meaning to. */
export const DESIGNED_TAG = "designed";
export const BANNER_TAG = "banner";

/** The most one designed post can hold: a post carries up to ten photos. */
export const MAX_DESIGN_SLIDES = 10;
/** The shapes a social post can be designed in. The fourth shape, 3:2, is the email banner. */
export const POST_FORMATS = ["4:5", "1:1", "9:16"] as const satisfies readonly SlideFormat[];

const has = (kit: BrandKit, layout: LayoutId) => kit.layouts.includes(layout);

/** The kit's colours as swatches, with white, for the colour pickers. */
export function kitSwatches(kit: BrandKit): { name: string; hex: string }[] {
  const colours = Object.entries(kit.palette).map(([name, hex]) => ({ name, hex }));
  return colours.some((c) => c.hex === "#ffffff")
    ? colours
    : [...colours, { name: "white", hex: "#ffffff" }];
}

/** A slide built in the workspace's kit. */
export function kitSlide(
  kit: BrandKit,
  layout: LayoutId,
  content: SlideContent,
  format: SlideFormat,
  id?: string,
): Slide {
  return buildSlide(layout, { ...content, brand: kit }, format, id);
}

/** Lay a slide out again in another layout, keeping its words, photos and colour. */
export function relayoutIn(
  kit: BrandKit,
  slide: Slide,
  layout: LayoutId,
  format: SlideFormat,
): Slide {
  return kitSlide(kit, layout, contentOf(slide), format, slide.id);
}

/**
 * The layout for a slide with this many photos. A kit doesn't draw every layout (a quiet kit has
 * no photo grid, a loud one no product card), so the nearest one it does draw is used.
 */
export function photoLayout(kit: BrandKit, wanted: LayoutId | undefined, photos: number): LayoutId {
  if (photos >= 2 && has(kit, "grid")) return "grid";
  if (wanted && ["product", "split", "sale", "photo"].includes(wanted) && has(kit, wanted))
    return wanted;
  return has(kit, "split") ? "split" : has(kit, "photo") ? "photo" : "statement";
}

/** Add a photo to a slide by laying it out again with a layout that has room for it. */
export function withPhotoIn(kit: BrandKit, slide: Slide, url: string, format: SlideFormat): Slide {
  const content = contentOf(slide);
  // Without a photo grid the slide holds one framed photo, so the new one takes its place.
  const photos = has(kit, "grid") ? [...(content.photos ?? []), url].slice(-4) : [url];
  const layout = photoLayout(kit, slide.layout as LayoutId | undefined, photos.length);
  return kitSlide(kit, layout, { ...content, photos }, format, slide.id);
}

/** Take a framed photo off a slide. A slide built from a layout is laid out again without it. */
export function withoutPicIn(
  kit: BrandKit,
  slide: Slide,
  picId: string,
  format: SlideFormat,
): Slide {
  const pics = slide.pics.filter((p) => p.id !== picId);
  if (!slide.layout) return { ...slide, pics };
  return kitSlide(kit, slide.layout as LayoutId, contentOf({ ...slide, pics }), format, slide.id);
}

/** A first slide in the workspace's look, optionally around a photo. */
export function starterSlideFor(
  kit: BrandKit,
  format: SlideFormat,
  options: { photo?: string | null; color?: string; words?: Words } = {},
): Slide {
  const words = options.words ?? {
    headline: "Your headline",
    body: "A line that says a little more.",
  };
  const photos = options.photo ? [options.photo] : [];
  const layout = photos.length ? photoLayout(kit, undefined, 1) : "statement";
  return kitSlide(
    kit,
    layout,
    { ...words, photos, color: options.color ?? kit.rotation[0] },
    format,
    newId("s"),
  );
}

/** A new design for a social post: one slide, in the feed shape. */
export function starterDesignFor(
  kit: BrandKit,
  options: { photo?: string | null; format?: SlideFormat } = {},
): SlideDesign {
  const format = options.format ?? "4:5";
  return { v: 1, format, slides: [starterSlideFor(kit, format, { photo: options.photo })] };
}

/** Another slide after `after`, in the next colour of the kit so two neighbours never match. */
export function nextSlideFor(kit: BrandKit, after: Slide, format: SlideFormat): Slide {
  const names = kit.rotation;
  const at = names.findIndex((name) => kit.palette[name] === after.bg);
  return starterSlideFor(kit, format, { color: names[(at + 1) % names.length] });
}

/** The banner layouts a kit can draw: an offer with its sticker when it has one, else a plain statement. */
export function bannerLayouts(kit: BrandKit): LayoutId[] {
  return has(kit, "sale") ? ["statement", "sale"] : ["statement"];
}

/** An email banner in the workspace's kit: one slide in the banner shape. */
export function bannerDesign(
  kit: BrandKit,
  words: Words,
  options: { layout?: string; color?: string } = {},
): SlideDesign {
  const layouts = bannerLayouts(kit);
  const layout = layouts.find((l) => l === options.layout) ?? "statement";
  const named = (options.color ?? "").trim().toLowerCase();
  const color = Object.prototype.hasOwnProperty.call(kit.palette, named) ? named : kit.rotation[0];
  return {
    v: 1,
    format: "3:2",
    slides: [
      kitSlide(
        kit,
        layout,
        // A sticker only belongs on the offer layout.
        { ...words, badge: layout === "sale" ? words.badge : "", color },
        "3:2",
        "banner",
      ),
    ],
  };
}

/** The colour that reads on a slide's background, for text added by hand. */
export function inkOn(kit: BrandKit, slide: Slide): string {
  return slide.image ? "#ffffff" : schemeFor(slide.bg, kit).ink;
}

/**
 * A design as it may be kept: complete, bounded, and picturing only the workspace's own assets.
 * `home` is the public address of the workspace's folder in the media bucket; a photo from
 * anywhere else is taken out, so a saved design can never point at another site or workspace.
 * Null when nothing usable is left.
 */
export function ownDesign(raw: unknown, home: string, maxSlides = MAX_DESIGN_SLIDES): SlideDesign | null {
  const design = normalizeDesign(raw);
  if (!design || !home || !FORMATS[design.format]) return null;
  const mine = (url: string) => url.startsWith(home) && !url.slice(home.length).includes("..");
  return {
    v: 1,
    format: design.format,
    slides: design.slides.slice(0, maxSlides).map((slide) => {
      const { brand: _brand, ...rest } = slide;
      const image = slide.image && mine(slide.image) ? slide.image : null;
      return {
        ...rest,
        image,
        imageDim: image ? slide.imageDim : 0,
        pics: slide.pics.filter((p) => mine(p.url)),
      };
    }),
  };
}
