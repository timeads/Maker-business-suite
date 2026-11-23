"use client";

import {
  saveDesignedPictures,
  startUpload,
  type DesignedPicture,
} from "@/app/w/[slug]/(app)/social/actions";
import type { BrandKit } from "@/lib/design/brands";
import type { SlideDesign } from "@/lib/design/slide-design";
import { renderSlideBlob } from "@/lib/design/slide-render";
import { getBrowserClient } from "@/lib/supabase/browser";

/**
 * Turns a design into pictures in the workspace's assets. Each slide is drawn here in the
 * browser, sent straight to storage with a one-time link from the server, and then registered
 * (with its design, so it can be opened again) once the server has checked what arrived.
 *
 * Social posts ask for JPEG, which Instagram needs; an email banner without a photo stays a PNG.
 * Throws with a plain message when something goes wrong; nothing half-made is left attached.
 */
export async function saveDesignAsPictures(
  slug: string,
  design: SlideDesign,
  kit: BrandKit,
  options: { jpeg: boolean; title: string; banner?: boolean; replaces?: string | null },
): Promise<DesignedPicture[]> {
  const drawn = [];
  for (const slide of design.slides) {
    drawn.push(await renderSlideBlob(slide, design, kit, { jpeg: options.jpeg }));
  }
  const started = await startUpload(
    slug,
    drawn.map((picture) => ({ type: picture.type, size: picture.blob.size })),
  );
  if ("error" in started) throw new Error(started.error);
  const storage = getBrowserClient().storage.from("social");
  for (const [index, picture] of drawn.entries()) {
    const ticket = started.tickets[index];
    const { error } = await storage.uploadToSignedUrl(ticket.path, ticket.token, picture.blob, {
      contentType: picture.type,
    });
    if (error) throw new Error("The picture didn't upload. Check your connection and try again.");
  }
  const many = design.slides.length > 1;
  const saved = await saveDesignedPictures(
    slug,
    design.slides.map((slide, index) => ({
      path: started.tickets[index].path,
      title: many ? `${options.title} ${index + 1}` : options.title,
      // Each picture keeps the one slide it was drawn from.
      design: { v: 1, format: design.format, slides: [slide] },
    })),
    { banner: options.banner, replaces: options.replaces },
  );
  if ("error" in saved) throw new Error(saved.error);
  return saved.pictures;
}

/** A name for a picture from the words on it. */
export function designTitle(design: SlideDesign, fallback: string): string {
  const layers = design.slides[0]?.layers ?? [];
  const words = (layers.find((l) => l.role === "headline") ?? layers[0])?.text ?? "";
  return words.replace(/\s+/g, " ").trim().slice(0, 80) || fallback;
}
