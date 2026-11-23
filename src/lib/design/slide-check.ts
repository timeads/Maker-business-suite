// Checking a designed slide the way a person would look it over: is any text cut off, does any
// text sit on other text or on a photo? And putting it right when it is not.
//
// Layouts place text from estimates of how much room it takes. The real size is only known once
// the text is measured in its real typeface, which happens in the browser. This module holds the
// rules; the measuring is passed in, so the rules can be tested.

import type { Slide, TextLayer } from "./slide-design";

/** Where a text really lands, in percentages of the slide. `tx`/`tw` are the words themselves, which are often narrower than the text box. */
export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
  tx: number;
  tw: number;
}
export type Measure = (layer: TextLayer) => TextBox;

export interface Issue {
  kind: "cut-off" | "overlap" | "over-photo";
  /** Ids of the texts involved. */
  layers: string[];
  /** The problem in plain words. */
  text: string;
}

const short = (l: TextLayer) =>
  `"${l.text.replace(/\s+/g, " ").trim().slice(0, 28)}${l.text.trim().length > 28 ? "..." : ""}"`;
const bottom = (b: TextBox) => b.y + b.h;
/** How far two spans overlap. */
const shared = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0);

/** The lowest a text may reach: clear of the wave when there is one. */
const floorOf = (slide: Slide) => (slide.wave ? 91 : 98);

/** Everything wrong with how the text sits on a slide. An empty list means it looks right. */
export function checkSlide(slide: Slide, measure: Measure): Issue[] {
  const issues: Issue[] = [];
  const texts = slide.layers.filter((l) => l.text.trim());
  const boxes = new Map(texts.map((l) => [l.id, measure(l)]));
  const floor = floorOf(slide);

  for (const l of texts) {
    const b = boxes.get(l.id)!;
    if (bottom(b) > floor + 0.5) {
      issues.push({
        kind: "cut-off",
        layers: [l.id],
        text:
          bottom(b) > 100
            ? `${short(l)} runs off the bottom of the picture.`
            : slide.wave
              ? `${short(l)} runs into the wave.`
              : `${short(l)} sits too close to the bottom edge.`,
      });
    }
    if (b.tx < -0.5 || b.tx + b.tw > 100.5)
      issues.push({
        kind: "cut-off",
        layers: [l.id],
        text: `${short(l)} runs off the side of the picture.`,
      });
    // Text belongs beside or below a framed photo, not across it. A price tag or sticker is meant to overlap one.
    if (!l.plate) {
      for (const pic of slide.pics) {
        if (pic.contain) continue;
        const down = shared(b.y, bottom(b), pic.y, pic.y + pic.h);
        const across = shared(b.tx, b.tx + b.tw, pic.x, pic.x + pic.w);
        if (down > b.h * 0.3 && across > 2) {
          issues.push({
            kind: "over-photo",
            layers: [l.id],
            text: `${short(l)} sits on top of a photo.`,
          });
          break;
        }
      }
    }
  }
  for (let i = 0; i < texts.length; i++) {
    for (let k = i + 1; k < texts.length; k++) {
      const a = boxes.get(texts[i].id)!;
      const c = boxes.get(texts[k].id)!;
      if (
        shared(a.y, bottom(a), c.y, bottom(c)) > 0.6 &&
        shared(a.tx, a.tx + a.tw, c.tx, c.tx + c.tw) > 1
      ) {
        issues.push({
          kind: "overlap",
          layers: [texts[i].id, texts[k].id],
          text: `${short(texts[i])} and ${short(texts[k])} overlap.`,
        });
      }
    }
  }
  return issues;
}

const MIN_SIZE: Partial<Record<string, number>> = {
  headline: 40,
  body: 26,
  accent: 44,
  kicker: 24,
};
const GAP = 2.4;

/**
 * Put a slide right: stack its running text (kicker, headline, body, aside) with clear space
 * between, move the stack up if there is room above it, and failing that make the text smaller a
 * step at a time until it fits. Stickers, price tags and a footer at the foot stay where they are.
 * A slide with nothing wrong is returned as it was. The result is marked as checked.
 */
export function fitSlide(slide: Slide, measure: Measure): Slide {
  if (checkSlide(slide, measure).length === 0) return { ...slide, fit: 1 };

  let layers = slide.layers.map((l) => ({ ...l }));
  const pinned = (l: TextLayer) => l.role === "badge" || (l.role === "footer" && l.y >= 78);
  const flowIds = layers
    .filter((l) => l.text.trim() && !pinned(l))
    .sort((a, b) => a.y - b.y)
    .map((l) => l.id);
  if (flowIds.length === 0) return { ...slide, fit: 1 };

  const first = layers.find((l) => l.id === flowIds[0])!;
  const startWanted = first.y;
  // Text placed under a photo cannot move up into it.
  const underPhoto = slide.pics
    .filter((p) => !p.contain && p.y + p.h <= startWanted + 3)
    .reduce((low, p) => Math.max(low, p.y + p.h), 0);
  const ceiling = underPhoto
    ? Math.max(underPhoto + 2.5, Math.min(startWanted, underPhoto + 4))
    : Math.min(startWanted, 7);

  for (let round = 0; round < 16; round++) {
    // The floor: a pinned footer, a logo, or the foot of the slide.
    const footer = layers.find((l) => l.role === "footer" && pinned(l) && l.text.trim());
    const logo = slide.pics
      .filter((p) => p.contain && p.y > startWanted)
      .reduce((top, p) => Math.min(top, p.y), 101);
    const floor = Math.min(footer ? measure(footer).y - 1.5 : floorOf(slide) - 2, logo - 2);

    const flow = flowIds.map((id) => layers.find((l) => l.id === id)!);
    const heights = flow.map((l) => measure(l).h);
    const total = heights.reduce((sum, h) => sum + h, 0) + GAP * (flow.length - 1);
    if (total <= floor - ceiling || round === 15) {
      let y = Math.max(ceiling, Math.min(startWanted, floor - total));
      flow.forEach((l, i) => {
        l.y = Math.round(y * 10) / 10;
        y += heights[i] + GAP;
      });
      break;
    }
    // Too much for the room there is: make the running text a little smaller and try again.
    layers = layers.map((l) => {
      if (!flowIds.includes(l.id)) return l;
      const least = MIN_SIZE[l.role ?? "body"] ?? 26;
      const step = l.role === "headline" || l.role === "accent" ? 0.92 : 0.96;
      return { ...l, size: Math.max(least, Math.round(l.size * step)) };
    });
  }
  return { ...slide, layers, fit: 1 };
}
