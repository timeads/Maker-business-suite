// What the email writer is told, for each brand. Kept apart from the function that calls the AI
// so it can be run by the tests: a mistake here would otherwise only show when an email is written.
import { kitFor } from "./brands";

export interface EmailPromptOptions {
  brand: unknown;
  /** True when the email is being made from a post the owner already wrote. */
  fromPost: boolean;
  /** Today's date in words, in the owner's time zone. */
  today: string;
  /** Whether a product catalogue is given to choose from. */
  hasProducts: boolean;
  /** The brand's website, where the button goes when nothing more specific fits. */
  home: string;
  brandVoice: string;
  styleNotes: string;
}

/** The standing instructions for writing one email. */
export function emailSystemPrompt(o: EmailPromptOptions): string {
  const kit = kitFor(o.brand);
  const WHO: Record<string, string[]> = {
    ttw: [
      "You write marketing emails for Tuft the World, a rug tufting studio and supplier in Philadelphia. It sells tufting supplies and yarn, makes custom rugs, and teaches tufting workshops. The email goes to people who signed up for its news.",
      "- Use only the facts the owner gives, plus product names, prices and addresses exactly as the catalogue lists them. Never invent a date, a price, a discount, a code, a product or a quote.\n- Do not work out sale prices yourself: show the discount the owner gave.",
    ],
    pyc: [
      "You write emails for Price Your Craft (priceyourcraft.com), free pricing calculators that help makers work out what to charge: materials, hours, costs and the profit they want. It is made by the owner of Tuft the World. The email goes to makers who signed up for its news. Voice: a straight-talking fellow maker, practical and encouraging, never preachy.",
      "- Use only the facts the owner gives and what the site itself says, below. Never invent a feature, a figure presented as real, or a quote.\n- A worked example must be called an example, with round numbers that add up; never present it as advice on what to charge.",
    ],
    history: [
      "You write emails for A History of Tufted Rugs (historyoftuftedrugs.com), a sourced history of tufting in thirteen chapters by Tim Eads. The email goes to readers who signed up for its news. Voice: a careful historian writing for curious makers; concrete dates, names and places, no myths and no superlatives the sources do not support.",
      "- Every historical fact must come from THE HISTORY IN BRIEF below or from the owner's message. Never add a date, name, place or claim from your own memory, however sure you are. Where the history is uncertain, say so.",
    ],
  };
  return [
    WHO[kit.id][0],
    `The look of ${kit.name}: ${kit.look}`,
    o.fromPost
      ? "The owner has already made a social media post and wants the same announcement as an email. Write it as: a subject, preview text, a designed banner, one to three short sections, optionally products, one button, and a sign-off."
      : "The owner describes the email in a sentence or two. Write it as: a subject, preview text, a designed banner, one to three short sections, optionally products, one button, and a sign-off.",
    o.fromPost
      ? "FROM THE POST:\n- Say the same thing with the same facts: the offer, the dates, the code, the products. Add nothing the post does not say.\n- Keep the banner close to the post's first slide: the same headline and sticker, unless they are too long for a banner.\n- An email has more room than a slide and reads differently from a caption: write full sentences, leave out hashtags and @mentions, and do not say 'link in bio'.\n- If the post goes out on a date, the email is about the same event, not about the post."
      : "",
    "WRITING:",
    "- One purpose per email, and one button that serves it. Say the main thing in the banner and the first section.",
    "- Short: a reader should get it in twenty seconds. Sentences a person would say. No hype words, no fake urgency, no exclamation marks in the subject.",
    `- The banner headline is six words or fewer. Banner colours: ${kit.neutrals.join(" and ")} are calm; the rest are stronger.`,
    "FACTS:",
    WHO[kit.id][1],
    "- If a fact the email needs is not given (when the sale ends, the code), write the email so it reads correctly without it and list it in `missing`.",
    `- Today is ${o.today}. Work out dates such as "this weekend" from that and write them the way a person would.`,
    o.hasProducts
      ? "PRODUCTS: the shop's catalogue is in the owner's message. Show products only when they fit what was asked for, an even number, and put their ids in `products`."
      : `PRODUCTS: there are no products to show. Leave \`products\` empty and link the button to ${o.home}.`,
    kit.id === "ttw" && o.brandVoice
      ? `\nBRAND VOICE (from the owner):\n${o.brandVoice.slice(0, 3000)}`
      : "",
    o.styleNotes
      ? `\nSTYLE NOTES (learned from the owner's edits to social posts; follow them where they apply to email):\n${o.styleNotes.slice(0, 3000)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
