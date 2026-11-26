/**
 * Sizing photos for where they go. Instagram refuses a feed photo taller than 4:5 or wider
 * than 1.91:1, and a Story is 9:16. A photo that doesn't fit is sent as a copy cropped to the
 * nearest shape that does, from the middle, as the earlier content app did (it cropped,
 * never padded); the original asset is never changed. Facebook takes photos as they are.
 *
 * Pure arithmetic, shared by the browser (which draws the copy), the server (which works out
 * what needs one) and, in its own words, the database (`private.social_photo_fits`, which
 * refuses to schedule a photo whose stored size doesn't fit). Keep the three in step.
 */

/** The places a photo is sized for. */
export type FitPlace = "instagram" | "instagram_story";

export const FIT_PLACES: readonly FitPlace[] = ["instagram", "instagram_story"];

/** Width over height, narrowest and widest, for each place. */
export const SHAPES: Record<FitPlace, { min: number; max: number; label: string }> = {
  instagram: { min: 4 / 5, max: 1.91, label: "between 4:5 and 1.91:1" },
  instagram_story: { min: 9 / 16, max: 9 / 16, label: "9:16" },
};

/** How far off a shape may be and still count: a pixel or two of rounding. */
export const TOLERANCE = 0.01;

/** The widest copy made. Instagram shows photos 1080 pixels wide. */
export const MAX_WIDTH = 1080;

export function fits(width: number, height: number, place: FitPlace): boolean {
  if (!(width > 0 && height > 0)) return false;
  const ratio = width / height;
  const { min, max } = SHAPES[place];
  return ratio >= min * (1 - TOLERANCE) && ratio <= max * (1 + TOLERANCE);
}

export type Crop = {
  /** The part of the original to keep, in its own pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** The copy's size. */
  width: number;
  height: number;
};

/**
 * The middle part of a photo that fits the place, and the size to draw it at; null when the
 * photo fits as it is. Too tall: the top and bottom are trimmed; too wide: the sides.
 */
export function cropFor(width: number, height: number, place: FitPlace): Crop | null {
  if (!(width > 0 && height > 0) || fits(width, height, place)) return null;
  const ratio = width / height;
  const { min, max } = SHAPES[place];
  const target = ratio < min ? min : max;
  let sw = width;
  let sh = height;
  if (ratio > target) sw = Math.round(height * target);
  else sh = Math.round(width / target);
  const sx = Math.floor((width - sw) / 2);
  const sy = Math.floor((height - sh) / 2);
  const outWidth = Math.min(sw, MAX_WIDTH);
  return {
    sx,
    sy,
    sw,
    sh,
    width: outWidth,
    height: Math.max(1, Math.round(outWidth / target)),
  };
}

/** Whether a photo needs its own copy for a place: the wrong shape, or not a JPEG. */
export function needsCopy(
  photo: { width: number | null; height: number | null; mimeType: string },
  place: FitPlace,
): boolean {
  if (photo.mimeType !== "image/jpeg") return true;
  if (photo.width == null || photo.height == null) return true;
  return !fits(photo.width, photo.height, place);
}

/** A copy's crop, or the whole photo when only the file type was wrong. */
export function copyCrop(width: number, height: number, place: FitPlace): Crop {
  const crop = cropFor(width, height, place);
  if (crop) return crop;
  const outWidth = Math.min(width, MAX_WIDTH);
  return {
    sx: 0,
    sy: 0,
    sw: width,
    sh: height,
    width: outWidth,
    height: Math.max(1, Math.round((height * outWidth) / width)),
  };
}
