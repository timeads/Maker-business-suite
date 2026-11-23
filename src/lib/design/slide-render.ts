/**
 * Browser-side helpers for slide designs: typefaces, photo loading, measuring and turning a
 * slide into a picture file. Everything here touches the page (canvas, fonts, images), so it is
 * only ever called from client components, after something has been clicked.
 *
 * A design is drawn with the kit it is given: a workspace's own kit (from `toDesignKit`) or a
 * built-in brand id. The typefaces are the ones the app ships, chosen by the kit's display
 * settings; nothing is fetched from anywhere else.
 */
import { kitFor, type BrandKit } from "./brands";
import { checkSlide, fitSlide, type Issue, type Measure } from "./slide-check";
import {
  FORMATS,
  canvasFont,
  drawSlide,
  fallbackFontResolver,
  layoutLayer,
  type DrawableImage,
  type FontResolver,
  type Slide,
  type SlideDesign,
  type SlideFont,
  type SlideFormat,
} from "./slide-design";

/** A kit, or a built-in brand's id. */
export type KitLike = BrandKit | string | null | undefined;

const SANS = '"Chivo", "Chivo Fallback", system-ui, -apple-system, "Segoe UI", sans-serif';
const READ = '"Tuft Slide Read", "Roboto", system-ui, -apple-system, "Segoe UI", sans-serif';
const HEADLINE = '"Tuft Slide Display", "Abril Fatface", Georgia, serif';
const ASIDE = '"Tuft Slide Aside", "Roboto", system-ui, sans-serif';

/**
 * The app's own font files under other names, each covering every weight. A design may ask for
 * a bold the file does not have; without this the browser would fake one by smearing the letters.
 */
const FACES: { family: string; file: string; weight: string }[] = [
  { family: "Tuft Slide Display", file: "abril-fatface-latin-400-normal.woff2", weight: "100 900" },
  { family: "Tuft Slide Read", file: "roboto-latin-400-normal.woff2", weight: "100 499" },
  { family: "Tuft Slide Read", file: "roboto-latin-500-normal.woff2", weight: "500 900" },
  { family: "Tuft Slide Aside", file: "roboto-latin-400-italic.woff2", weight: "100 900" },
];

/**
 * Whether a kit's headlines are set in the display serif. Kits that shout (all capitals) or keep
 * quiet (a smaller display size) use the sans instead, in its real weights.
 */
export function serifHeadlines(kit: KitLike): boolean {
  const { display } = kitFor(kit);
  return !display.uppercase && display.scale >= 1;
}

/** Which of the app's typefaces each kind of slide text is drawn in, for a kit. */
export function fontResolverFor(kit?: KitLike): FontResolver {
  const headline = serifHeadlines(kit) ? HEADLINE : SANS;
  const stacks: Partial<Record<SlideFont, string>> = {
    display: headline,
    body: READ,
    read: READ,
    label: SANS,
    ui: SANS,
    hand: ASIDE,
  };
  return (font) => stacks[font] ?? fallbackFontResolver(font);
}

/** The names shown for each kind of text in the editor. */
export const SLIDE_FONT_NAMES: Record<SlideFont, string> = {
  display: "Headline",
  body: "Reading",
  label: "Label",
  hand: "Aside (italic)",
  ui: "Plain",
  read: "Reading",
  serif: "Serif",
  mono: "Typewriter",
};

let faces: Promise<void> | null = null;

/** Register the app's font files once per visit. One that fails falls back to the next in the list. */
function loadFaces(): Promise<void> {
  if (!faces) {
    faces = (async () => {
      if (typeof FontFace === "undefined" || !document.fonts?.add) return;
      await Promise.all(
        FACES.map(async ({ family, file, weight }) => {
          try {
            const face = await new FontFace(family, `url("/fonts/${file}") format("woff2")`, {
              weight,
            }).load();
            document.fonts.add(face);
          } catch {
            // The next face in the stack is used instead.
          }
        }),
      );
    })().catch(() => undefined);
  }
  return faces;
}

/**
 * Make sure every typeface a slide uses is loaded before it is measured or drawn, so a picture
 * never comes out in a stand-in face.
 */
export async function ensureSlideFonts(slide: Slide, kit?: KitLike): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  await loadFaces();
  const resolve = fontResolverFor(kit);
  const wanted = new Set(slide.layers.map((l) => canvasFont(l, 40, resolve)));
  await Promise.all([...wanted].map((font) => document.fonts.load(font).catch(() => undefined)));
  await document.fonts.ready.catch(() => undefined);
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();

/**
 * Load a photo so it can be drawn and saved as part of a picture. It is asked for with
 * `crossOrigin="anonymous"`: without that the browser lets it be shown but not exported.
 */
export function loadSlideImage(url: string): Promise<HTMLImageElement> {
  let pending = imageCache.get(url);
  if (!pending) {
    pending = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(url);
        reject(new Error(PHOTO_PROBLEM));
      };
      img.src = url;
    });
    imageCache.set(url, pending);
  }
  return pending;
}

export const PHOTO_PROBLEM =
  "A photo in this design couldn't be loaded. Choose it again from your assets, or take it out, then try once more.";

/** Everything a slide pictures: the photo that fills it and each framed photo. One that fails is left out and counted. */
export async function loadSlideImages(slide: Slide): Promise<{
  image: HTMLImageElement | null;
  pics: Record<string, DrawableImage | null>;
  missing: number;
}> {
  const quiet = (url: string) => loadSlideImage(url).catch(() => null);
  const urls = [...new Set(slide.pics.map((p) => p.url))];
  const [image, ...loaded] = await Promise.all([
    slide.image ? quiet(slide.image) : Promise.resolve(null),
    ...urls.map(quiet),
  ]);
  const missing = (slide.image && !image ? 1 : 0) + loaded.filter((img) => !img).length;
  return { image, pics: Object.fromEntries(urls.map((u, i) => [u, loaded[i]])), missing };
}

/** Measure a slide's texts in their real typefaces, as percentages of the slide. Fonts must be loaded first. */
export function measureFor(slide: Slide, format: SlideFormat, kit?: KitLike): Measure {
  const { w: W, h: H } = FORMATS[format];
  const ctx = document.createElement("canvas").getContext("2d");
  const resolve = fontResolverFor(kit);
  return (layer) => {
    if (!ctx) return { x: layer.x, y: layer.y, w: layer.w, h: 0, tx: layer.x, tw: layer.w };
    ctx.font = canvasFont(layer, layer.size, resolve);
    const box = layoutLayer(layer, W, H, (t) => ctx.measureText(t).width);
    const widest = Math.min(
      box.w,
      Math.max(0, ...box.lines.map((line) => ctx.measureText(line).width)),
    );
    const left =
      layer.align === "left"
        ? box.x
        : layer.align === "center"
          ? box.x + (box.w - widest) / 2
          : box.x + box.w - widest;
    // An underline takes room below the words.
    const under = layer.scribble ? layer.size * 0.3 : 0;
    return {
      x: layer.x,
      y: layer.y,
      w: layer.w,
      h: ((box.h + under) / H) * 100,
      tx: (left / W) * 100,
      tw: (widest / W) * 100,
    };
  };
}

/** Check a slide with its real typefaces and put right any text that is cut off or overlapping. */
export async function fitSlideMeasured(
  slide: Slide,
  format: SlideFormat,
  kit?: KitLike,
): Promise<Slide> {
  await ensureSlideFonts(slide, kit);
  return fitSlide(slide, measureFor(slide, format, kit));
}

/** What is wrong with a slide's text, if anything. */
export async function checkSlideMeasured(
  slide: Slide,
  format: SlideFormat,
  kit?: KitLike,
): Promise<Issue[]> {
  await ensureSlideFonts(slide, kit);
  return checkSlide(slide, measureFor(slide, format, kit));
}

/** Fit every slide of a design that was built by a layout and has not been checked yet. */
export async function fitDesign(design: SlideDesign, kit?: KitLike): Promise<SlideDesign> {
  if (!design.slides.some((s) => s.layout && !s.fit)) return design;
  return {
    ...design,
    slides: await Promise.all(
      design.slides.map((s) => (s.layout && !s.fit ? fitSlideMeasured(s, design.format, kit) : s)),
    ),
  };
}

export type RenderedSlide = { blob: Blob; ext: "png" | "jpg"; type: "image/png" | "image/jpeg" };

/**
 * Draw one slide at full size and hand back the picture file. JPEG when asked for (social posts
 * need it) or when there is a photo; otherwise PNG, which keeps flat colour and type crisp.
 */
export async function renderSlideBlob(
  given: Slide,
  design: SlideDesign,
  kit?: KitLike,
  options: { jpeg?: boolean } = {},
): Promise<RenderedSlide> {
  const { w, h } = FORMATS[design.format];
  // A slide straight from a layout is checked before it is drawn, so no picture goes out with text cut off.
  const slide =
    given.layout && !given.fit ? await fitSlideMeasured(given, design.format, kit) : given;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't make pictures. Try another browser.");
  await ensureSlideFonts(slide, kit);
  // For the final picture a missing photo is an error, not a blank frame.
  const image = slide.image ? await loadSlideImage(slide.image) : null;
  const urls = [...new Set(slide.pics.map((p) => p.url))];
  const loaded = await Promise.all(urls.map(loadSlideImage));
  drawSlide(
    ctx,
    slide,
    w,
    h,
    image,
    fontResolverFor(kit),
    Object.fromEntries(urls.map((u, i) => [u, loaded[i]])),
  );
  const hasPhoto = !!slide.image || slide.pics.length > 0;
  const type = options.jpeg || hasPhoto ? "image/jpeg" : "image/png";
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  } catch {
    // A photo the browser was not allowed to read back makes the whole picture unreadable.
    throw new Error(PHOTO_PROBLEM);
  }
  if (!blob) throw new Error("The picture couldn't be made. Please try again.");
  return { blob, ext: type === "image/jpeg" ? "jpg" : "png", type };
}
