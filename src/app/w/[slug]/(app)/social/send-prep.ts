"use client";

import type { BrandKit } from "@/lib/design/brands";
import { renderSlideBlob } from "@/lib/design/slide-render";
import { getBrowserClient } from "@/lib/supabase/browser";
import { attachSlides, sendingPlan, startUpload } from "./actions";

/**
 * Gets a saved post ready to be scheduled or approved, in this browser: its slides are drawn
 * into pictures with the workspace's kit and the app's own fonts (as the designer draws them),
 * sent to storage with one-time links, and attached in order once the server has checked what
 * arrived. Nothing is scheduled here; the caller's own press does that afterwards, and the
 * database refuses it if the pictures don't match the slides.
 *
 * Returns a plain message when something goes wrong. The post is left as a draft.
 */
export async function getReadyToSend(
  slug: string,
  postId: string,
  kit: BrandKit | null,
): Promise<{ error?: string }> {
  const plan = await sendingPlan(slug, postId);
  if ("error" in plan) return { error: plan.error };
  if (!plan.slides || !plan.key) return {};
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
