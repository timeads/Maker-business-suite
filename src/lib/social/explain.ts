import { SHAPES, fits, type FitPlace } from "./fit";
import { PLACE_RULES, checkPlace, problemWords, type Place } from "./networks";

/**
 * "How this is worked out" for Social: what stands between a post and
 * being scheduled (each place's rules from `PLACE_RULES`, the photo shapes
 * of `fit.ts`, the workspace's review setting), and what a target's state
 * means. Pure, from the same rules the composer and the database check.
 */

export type ScheduleFacts = {
  places: Place[];
  /** The words that go to a place (its own caption, else the shared one). */
  wordsFor: (place: Place) => string;
  /** The post's photos in order, with their size as the server read it (null: not read). */
  photos: { width: number | null; height: number | null }[];
  video: boolean;
  /** Approval is required here and this person can't schedule without it. */
  needsApproval: boolean;
};

const FIT: Partial<Record<Place, FitPlace>> = {
  instagram: "instagram",
  instagram_story: "instagram_story",
};

/** Why a post can or can't be scheduled yet, one line per reason. */
export function scheduleExplained(facts: ScheduleFacts): string[] {
  if (facts.places.length === 0) {
    return ["Tick at least one place for it to go before it can be scheduled."];
  }
  const lines: string[] = [];
  for (const place of facts.places) {
    for (const problem of checkPlace(place, {
      words: facts.wordsFor(place),
      photos: facts.photos.length,
      video: facts.video,
    })) {
      lines.push(problemWords(problem));
    }
  }
  if (!facts.video) {
    for (const place of facts.places) {
      const fit = FIT[place];
      if (!fit) continue;
      const label = PLACE_RULES[place].label;
      facts.photos.forEach((photo, i) => {
        const which = facts.photos.length === 1 ? "The photo" : `Photo ${i + 1}`;
        if (!photo.width || !photo.height) {
          lines.push(
            `${which}'s size hasn't been read yet, so it can't go to ${label}. Taking it out and adding it again reads it.`,
          );
        } else if (!fits(photo.width, photo.height, fit)) {
          const ratio = photo.width / photo.height;
          const shape = ratio < SHAPES[fit].min ? "taller" : "wider";
          lines.push(
            `${which} is ${shape} than ${label} takes (${SHAPES[fit].label}), so a copy cropped from the middle goes there when you schedule. Your photo itself never changes.`,
          );
        }
      });
    }
  }
  if (facts.needsApproval) {
    lines.push(
      "This workspace approves posts before they go out: send it for review, and an approver schedules it.",
    );
  }
  if (lines.length === 0) lines.push("Nothing stands in the way: pick a time and schedule it.");
  return lines;
}

export type TargetResult = {
  id?: string;
  error?: string;
  pending?: string;
  unsure?: string;
  sending?: string;
  checked_by?: string;
};

/** What one target's state means, and what the person can do about it. */
export function targetExplained(result: TargetResult | undefined, network: string): string {
  if (!result) return "Waiting for its time. Nothing has been sent there yet.";
  if (result.id) {
    return result.checked_by
      ? `Someone checked ${network} and said it's there, so it's counted as posted and never sent again.`
      : `${network} has it. It's never sent there again, even if the post is tried again for another place.`;
  }
  if (result.pending) {
    return `${network} took the video and is still preparing it. We ask how it's going rather than send it again, so it can't go up twice.`;
  }
  if (result.unsure || result.sending) {
    return `We sent it but never heard back from ${network}, so it may be up or not. Look on ${network}, then say which: nothing is sent again until you do.`;
  }
  if (result.error) {
    return `${network} said no. Change what it asks for and try again: only the places that didn't go are sent.`;
  }
  return "Waiting for its time. Nothing has been sent there yet.";
}
