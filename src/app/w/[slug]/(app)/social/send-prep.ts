"use client";

import type { BrandKit } from "@/lib/design/brands";
import type { SlideDesign } from "@/lib/design/slide-design";
import { loadSlideImage, renderSlideBlob } from "@/lib/design/slide-render";
import { copyCrop, type FitPlace } from "@/lib/social/fit";
import { getBrowserClient } from "@/lib/supabase/browser";
import { attachSlides, saveFits, sendingPlan, startUpload, type FitPlan } from "./actions";

/**
 * Gets a saved post ready to be scheduled or approved, in this browser: its slides are drawn
 * into pictures with the workspace's kit and the app's own fonts (as the designer draws them),
 * sent to storage with one-time links, and attached in order once the server has checked what
 * arrived. Then each photo Instagram wouldn't take is copied to a shape it does (cropped from
 * the middle), the same way; the original is left as it is. Nothing is scheduled here; the
 * caller's own press does that afterwards, and the database refuses it if anything is off.
 *
 * Returns a plain message when something goes wrong. The post is left as a draft.
 */
export async function getReadyToSend(
  slug: string,
  postId: string,
  kit: BrandKit | null,
): Promise<{ error?: string }> {
  const first = await sendingPlan(slug, postId);
  if ("error" in first) return { error: first.error };
  if (first.slides && first.key) {
    const drawn = await drawSlides(slug, postId, first.slides, first.key, kit);
    if (drawn.error) return drawn;
  }
  const plan = first.slides ? await sendingPlan(slug, postId) : first;
  if ("error" in plan) return { error: plan.error };
  if (plan.fits.length === 0) return {};
  return sizePhotos(slug, postId, plan.fits);
}

async function drawSlides(
  slug: string,
  postId: string,
  slides: SlideDesign,
  key: string,
  kit: BrandKit | null,
): Promise<{ error?: string }> {
  const plan = { slides, key };
  try {
    const drawn = [];
    for (const slide of plan.slides.slides) {
      drawn.push(await renderSlideBlob(slide, plan.slides, kit ?? undefined, { jpeg: true }));
    }
    const started = await startUpload(
      slug,
      drawn.map((picture) => ({ type: picture.type, size: picture.blob.size })),
    );
    if ("error" in started) return { error: started.error };
    const storage = getBrowserClient().storage.from("social");
    for (const [index, picture] of drawn.entries()) {
      const ticket = started.tickets[index];
      const { error } = await storage.uploadToSignedUrl(ticket.path, ticket.token, picture.blob, {
        contentType: picture.type,
      });
      if (error) {
        return { error: "The slides didn't upload. Check your connection and try again." };
      }
    }
    const attached = await attachSlides(
      slug,
      postId,
      plan.key,
      started.tickets.map((ticket) => ticket.path),
    );
    return "error" in attached ? { error: attached.error } : {};
  } catch (err) {
    return {
      error:
        err instanceof Error && err.message
          ? `The slides couldn't be drawn: ${err.message}`
          : "The slides couldn't be drawn. Please try again.",
    };
  }
}

/** Draws one copy: the middle part of the photo that fits, as a JPEG. */
async function drawCopy(url: string, place: FitPlace): Promise<Blob> {
  const image = await loadSlideImage(url);
  // The size the browser shows it at (turned the way the photo says) decides the crop.
  const crop = copyCrop(image.naturalWidth, image.naturalHeight, place);
  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser couldn't draw the copy.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, crop.width, crop.height);
  context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.width, crop.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("This browser couldn't draw the copy.");
  return blob;
}

/** Copies each photo a place wouldn't take, sends the copies up and tells the post. */
async function sizePhotos(
  slug: string,
  postId: string,
  fits: FitPlan[],
): Promise<{ error?: string }> {
  const wanted = fits.flatMap((fit) => fit.needs.map((need) => ({ place: fit.place, need })));
  try {
    const blobs: Blob[] = [];
    for (const { place, need } of wanted) blobs.push(await drawCopy(need.url, place));
    let paths: string[] = [];
    if (blobs.length > 0) {
      const started = await startUpload(
        slug,
        blobs.map((blob) => ({ type: "image/jpeg", size: blob.size })),
      );
      if ("error" in started) return { error: started.error };
      const storage = getBrowserClient().storage.from("social");
      for (const [index, blob] of blobs.entries()) {
        const ticket = started.tickets[index];
        const { error } = await storage.uploadToSignedUrl(ticket.path, ticket.token, blob, {
          contentType: "image/jpeg",
        });
        if (error) {
          return { error: "A sized copy didn't upload. Check your connection and try again." };
        }
      }
      paths = started.tickets.map((ticket) => ticket.path);
    }
    const saved = await saveFits(
      slug,
      postId,
      wanted.map(({ place, need }, index) => ({ place, index: need.index, path: paths[index] })),
    );
    return "error" in saved ? { error: saved.error } : {};
  } catch (err) {
    return {
      error:
        err instanceof Error && err.message
          ? `A photo couldn't be sized for Instagram: ${err.message}`
          : "A photo couldn't be sized for Instagram. Please try again.",
    };
  }
}
