// Looking over an email for things worth fixing before it is sent: the one place that decides
// what is wrong, how serious it is, and whether it can be put right in one step. The Optimize
// panel shows everything found here; the "Before you send" list is the same findings, less the
// ones that are only tips.
//
// A fix is a list of ordinary changes to the document, so applying one is undoable like any
// other change, and only offered where the right answer is not a matter of taste.
//
// Pure: no network, no DOM and no Deno APIs.

import { kitFor } from "./brands";
import { UNSUBSCRIBE_PLACEHOLDER } from "./email";
import {
  SIZE_LIMIT,
  buttonLook,
  contrast,
  firstButton,
  imageLook,
  inlineText,
  logoLook,
  newBlock,
  textLook,
  type Block,
  type EmailDoc,
  type Section,
  type TextKind,
} from "./email-doc";
import { htmlBytes, renderDocHtml } from "./email-doc-html";
import { docLinks } from "./email-doc-links";
import type { DocAction } from "./email-doc-reduce";
import { localStatus } from "./link-check";

/** error: the email is wrong or incomplete as it stands. warn: likely to cost readers. tip: could be better. */
export type SuggestionLevel = "error" | "warn" | "tip";

export interface Suggestion {
  /** Stays the same for the same finding on the same block, so a list of them can be kept in step. */
  id: string;
  rule: string;
  level: SuggestionLevel;
  title: string;
  /** Why it matters, in plain words. */
  detail: string;
  /** The block to show, where the finding is about one. */
  blockId?: string;
  /** The changes that put it right, where there is a safe way to. */
  fix?: DocAction[];
  /** What the fix does, for the button: "Add a footer". */
  fixLabel?: string;
}

/** Text this small is hard to read on a phone. */
export const MIN_PHONE_TEXT = 14;
/** How strongly ordinary text must stand out from what is behind it; large text may be a little weaker. */
export const MIN_CONTRAST = 4.5;
export const MIN_CONTRAST_LARGE = 3;
const LONG_TEXT = 900;
const MANY_BUTTONS = 3;

const ratio = (n: number) => `${Math.round(n * 10) / 10} to 1`;
/** Whichever of the brand's dark and light colours stands out more from a background. */
function readable(doc: EmailDoc, background: string): string {
  const kit = kitFor(doc.brand);
  const dark = kit.palette[kit.dark];
  const light = kit.palette[kit.light];
  const best = contrast(dark, background) >= contrast(light, background) ? dark : light;
  // If neither brand colour is clear enough, plain black or white always is.
  return contrast(best, background) >= MIN_CONTRAST
    ? best
    : contrast("#000000", background) >= contrast("#ffffff", background)
      ? "#000000"
      : "#ffffff";
}

function visit(doc: EmailDoc, fn: (block: Block, section: Section) => void) {
  for (const section of doc.sections)
    for (const row of section.rows)
      for (const column of row.columns) for (const block of column.blocks) fn(block, section);
}

/** Everything worth a look in this email, most serious first, in reading order within each level. */
export function optimize(doc: EmailDoc): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (s: Suggestion) => {
    if (!out.some((x) => x.id === s.id)) out.push(s);
  };
  const g = doc.globalStyles;
  const blocks: Block[] = [];
  visit(doc, (b) => blocks.push(b));

  /* The subject and preview text */
  const subject = doc.meta.subject.trim();
  if (!subject)
    add({
      id: "subject-missing",
      rule: "subject-missing",
      level: "error",
      title: "Add a subject line.",
      detail: "The subject is what readers see in their inbox. Set it under Email details.",
    });
  else {
    if (subject.length > 60)
      add({
        id: "subject-long",
        rule: "subject-long",
        level: "warn",
        title: "The subject is over 60 characters; phones will cut it off.",
        detail: `It is ${subject.length} characters. Phones show about the first 35 to 40, so put what matters first.`,
      });
    const letters = subject.replace(/[^\p{L}]/gu, "");
    if (
      letters.length >= 6 &&
      letters === letters.toUpperCase() &&
      letters !== letters.toLowerCase()
    ) {
      add({
        id: "subject-caps",
        rule: "subject-caps",
        level: "warn",
        title: "The subject is all in capitals.",
        detail:
          "Capitals all the way through read as shouting, and spam filters count them against an email.",
        fix: [{ type: "setMeta", patch: { subject: subject[0] + subject.slice(1).toLowerCase() } }],
        fixLabel: "Use ordinary letters",
      });
    }
    if ((subject.match(/!/g) ?? []).length > 1) {
      let seen = false;
      add({
        id: "subject-exclaim",
        rule: "subject-exclaim",
        level: "warn",
        title: "The subject has more than one exclamation mark.",
        detail: "One is plenty. Several look like spam to readers and to spam filters.",
        fix: [
          {
            type: "setMeta",
            patch: {
              subject: subject
                .replace(/!+/g, () => (seen ? "" : ((seen = true), "!")))
                .replace(/\s{2,}/g, " ")
                .trim(),
            },
          },
        ],
        fixLabel: "Keep just one",
      });
    }
  }
  if (!doc.meta.previewText.trim())
    add({
      id: "preview-missing",
      rule: "preview-missing",
      level: "warn",
      title: "Add preview text: it shows next to the subject in the inbox.",
      detail:
        "Without it the inbox shows whatever words come first in the email. Set it under Email details.",
    });

  /* What the email is made of */
  const wordy =
    blocks.some(
      (b) => (b.type === "heading" || b.type === "paragraph") && inlineText(b.html).length > 0,
    ) || blocks.some((b) => b.type === "code" && b.html);
  const pictures = blocks.some(
    (b) =>
      (b.type === "image" && !!imageLook(doc, b).src && b.role !== "logo") ||
      (b.type === "banner" && !!b.image) ||
      (b.type === "video" && !!b.thumbnail),
  );
  if (pictures && !wordy)
    add({
      id: "image-only",
      rule: "image-only",
      level: "warn",
      title: "The email is all pictures, with no text.",
      detail:
        "Many email programs hide pictures until the reader allows them, and spam filters distrust emails with no words. Add a line or two of text.",
    });

  const working = blocks.filter((b) => b.type === "button" && b.label && b.url);
  if (!firstButton(doc))
    add({
      id: "button-none",
      rule: "button-none",
      level: "warn",
      title: "Add a button with a link, so readers have somewhere to go.",
      detail:
        "An email with one clear button gets more clicks than one that leaves readers to find a link.",
    });
  else if (working.length > MANY_BUTTONS)
    add({
      id: "button-many",
      rule: "button-many",
      level: "tip",
      title: `There are ${working.length} buttons.`,
      detail:
        "Each extra button takes attention from the others. One main button, and plain links for the rest, usually does better.",
      blockId: working[MANY_BUTTONS].id,
    });

  if (!blocks.some((b) => b.type === "footer")) {
    const last = doc.sections[doc.sections.length - 1];
    add({
      id: "footer-missing",
      rule: "footer-missing",
      level: "error",
      title: "Add a Footer block: it holds the unsubscribe link every marketing email needs.",
      detail:
        "Email platforms will not send a marketing email without a way to unsubscribe, and the law in most places requires one.",
      fix: [
        {
          type: "insertBlock",
          block: newBlock("footer", doc.brand),
          at: { sectionId: last.id, rowIndex: last.rows.length },
        },
      ],
      fixLabel: "Add a footer",
    });
  } else if (doc.platform === "other") {
    add({
      id: "unsubscribe-marker",
      rule: "unsubscribe-marker",
      level: "warn",
      title: `Before sending, replace ${UNSUBSCRIBE_PLACEHOLDER} in the code with your email platform's own unsubscribe tag.`,
      detail:
        "The marker shows where the unsubscribe link goes. Your platform's help pages give the exact tag to put there.",
      blockId: blocks.find((b) => b.type === "footer")?.id,
    });
  }

  /* Block by block */
  const smallKinds = new Set<TextKind>();
  visit(doc, (block, section) => {
    const about = { blockId: block.id };
    const behind = block.styles.background ?? section.styles.contentBg ?? g.contentBg;
    switch (block.type) {
      case "banner":
        if (!block.image)
          add({
            id: `banner-unmade:${block.id}`,
            rule: "banner-unmade",
            level: "warn",
            title: "The banner picture has not been made yet.",
            detail:
              "Until it is made the banner goes out as plain words on a colour. Select the banner and use Edit design.",
            ...about,
          });
        else if (!block.alt.trim())
          add({
            id: `alt:${block.id}`,
            rule: "image-alt",
            level: "warn",
            title: "The banner has no description.",
            detail:
              "Say what the banner says in a few words, for readers whose email program hides pictures and for people using a screen reader.",
            ...about,
          });
        break;
      case "image": {
        const look = imageLook(doc, block);
        if (!look.src)
          add({
            id: `image-empty:${block.id}`,
            rule: "image-empty",
            level: "error",
            title: "An image block has no picture yet, so it is left out of the email.",
            detail: "Choose a picture for it, or delete the block.",
            ...about,
          });
        else if (!block.alt.trim()) {
          add({
            id: `alt:${block.id}`,
            rule: "image-alt",
            level: "warn",
            title:
              "Describe each image in a few words, for readers whose email program hides pictures.",
            detail:
              "The description is shown when the picture is not, and read out by screen readers.",
            ...about,
            // A logo's description is the brand's name; any other picture needs a person to say what it shows.
            ...(block.role === "logo"
              ? {
                  fix: [
                    { type: "updateBlock", id: block.id, patch: { alt: kitFor(doc.brand).name } },
                  ] as DocAction[],
                  fixLabel: "Use the brand's name",
                }
              : {}),
          });
        }
        break;
      }
      case "logo":
        if (!logoLook(doc, block).src)
          add({
            id: `image-empty:${block.id}`,
            rule: "image-empty",
            level: "error",
            title: "The logo has no picture yet, so it is left out of the email.",
            detail: "Choose the logo under Styles, then Logo, or in the block itself.",
            ...about,
          });
        else if (!block.alt.trim())
          add({
            id: `alt:${block.id}`,
            rule: "image-alt",
            level: "warn",
            title: "The logo has no description.",
            detail: "It is shown when the picture is not, and read out by screen readers.",
            ...about,
            fix: [{ type: "updateBlock", id: block.id, patch: { alt: kitFor(doc.brand).name } }],
            fixLabel: "Use the brand's name",
          });
        break;
      case "video":
        if (!block.url || !block.thumbnail)
          add({
            id: `video-empty:${block.id}`,
            rule: "video-empty",
            level: "error",
            title:
              "A video block is missing its link or its picture, so it is left out of the email.",
            detail: "Give it the video's address and a still picture to show.",
            ...about,
          });
        break;
      case "social":
        if (!block.links.some((l) => l.url))
          add({
            id: `social-empty:${block.id}`,
            rule: "social-empty",
            level: "error",
            title: "A social block has no addresses yet, so it is left out of the email.",
            detail: "Give at least one account its address, or delete the block.",
            ...about,
          });
        break;
      case "button": {
        if (!block.label || !block.url) {
          add({
            id: `button-unfinished:${block.id}`,
            rule: "button-unfinished",
            level: "error",
            title: "A button is missing its words or its link, so it is left out of the email.",
            detail: !block.label
              ? "Type the words for the button on the email itself."
              : "Give the button a link in its settings.",
            ...about,
          });
          break;
        }
        const look = buttonLook(doc, block);
        const c = contrast(look.color, look.bg);
        if (c < MIN_CONTRAST) {
          const better = readable(doc, look.bg);
          add({
            id: `contrast-button:${block.styles.color ? block.id : "all"}`,
            rule: "contrast-button",
            level: "warn",
            title: "The words on the button are hard to read against its colour.",
            detail: `They stand out ${ratio(c)}; at least ${ratio(MIN_CONTRAST)} is needed to be read comfortably.`,
            ...about,
            // The words' colour comes from the block when it has its own, otherwise from the email's button style.
            fix: block.styles.color
              ? [{ type: "updateBlockStyles", id: block.id, patch: { color: better } }]
              : [{ type: "setGlobalStyles", patch: { button: { ...g.button, color: better } } }],
            fixLabel: "Use a colour that reads",
          });
        }
        if (buttonLook(doc, block, "mobile").fontSize < MIN_PHONE_TEXT)
          add({
            id: `small:${block.id}`,
            rule: "small-text",
            level: "warn",
            title: "The words on a button are small on a phone.",
            detail: `They are ${buttonLook(doc, block, "mobile").fontSize} pixels. Under ${MIN_PHONE_TEXT} is hard to read and hard to tap.`,
            ...about,
          });
        break;
      }
      case "heading":
      case "paragraph": {
        const words = inlineText(block.html);
        if (!words) break;
        if (block.type === "paragraph" && words.length > LONG_TEXT)
          add({
            id: `long:${block.id}`,
            rule: "long-text",
            level: "tip",
            title: "A block of text is very long.",
            detail: `It is about ${Math.round(words.split(/\s+/).length / 10) * 10} words. Readers skim: shorter paragraphs, a heading, or a link to read more, keep them going.`,
            ...about,
          });
        const look = textLook(doc, block, section, "desktop");
        const c = contrast(look.color, behind);
        const large = look.size >= 24 || (look.bold && look.size >= 19);
        if (c < (large ? MIN_CONTRAST_LARGE : MIN_CONTRAST)) {
          add({
            id: `contrast-text:${block.id}`,
            rule: "contrast-text",
            level: "warn",
            title: "Some text is hard to read against its background.",
            detail: `It stands out ${ratio(c)}; ${large ? "large" : "ordinary"} text needs at least ${ratio(large ? MIN_CONTRAST_LARGE : MIN_CONTRAST)}.`,
            ...about,
            fix: [
              { type: "updateBlockStyles", id: block.id, patch: { color: readable(doc, behind) } },
            ],
            fixLabel: "Use a colour that reads",
          });
        }
        const small = textLook(doc, block, section, "mobile");
        if (small.size < MIN_PHONE_TEXT) {
          const own =
            block.styles.size !== undefined ||
            (!block.styles.sameForMobile && block.styles.mobile?.size !== undefined);
          const kind: TextKind = block.type === "heading" ? (`h${block.level}` as TextKind) : "p";
          if (own) {
            add({
              id: `small:${block.id}`,
              rule: "small-text",
              level: "warn",
              title: "Some text is small on a phone.",
              detail: `It is ${small.size} pixels. Under ${MIN_PHONE_TEXT} is hard to read on a phone.`,
              ...about,
              fix: [
                {
                  type: "updateBlockStyles",
                  id: block.id,
                  patch: block.styles.sameForMobile
                    ? { size: MIN_PHONE_TEXT }
                    : { mobile: { ...block.styles.mobile, size: MIN_PHONE_TEXT } },
                },
              ],
              fixLabel: `Make it ${MIN_PHONE_TEXT} pixels`,
            });
          } else if (!smallKinds.has(kind)) {
            // One finding for the style, not one for every block that follows it.
            smallKinds.add(kind);
            const style = g.text[kind];
            const device = style.sameForMobile ? "desktop" : "mobile";
            add({
              id: `small:${kind}`,
              rule: "small-text",
              level: "warn",
              title:
                kind === "p"
                  ? "Paragraph text is small on a phone."
                  : "A heading size is small on a phone.",
              detail: `It is ${small.size} pixels. Under ${MIN_PHONE_TEXT} is hard to read on a phone.`,
              ...about,
              fix: [
                {
                  type: "setGlobalStyles",
                  patch: {
                    text: {
                      ...g.text,
                      [kind]: { ...style, [device]: { ...style[device], size: MIN_PHONE_TEXT } },
                    },
                  },
                },
              ],
              fixLabel: `Make it ${MIN_PHONE_TEXT} pixels`,
            });
          }
        }
        break;
      }
      case "products":
        if (block.items.length === 0)
          add({
            id: `products-empty:${block.id}`,
            rule: "products-empty",
            level: "error",
            title: "A products block has no products yet, so it is left out of the email.",
            detail: "Add products to it, or delete the block.",
            ...about,
          });
        else if (block.items.length % 2 === 1 && block.items.length > 1)
          add({
            id: `products-odd:${block.id}`,
            rule: "products-odd",
            level: "tip",
            title: "An odd number of products leaves a gap in the last row.",
            detail: "Products sit two to a row. Add or remove one to fill the row.",
            ...about,
          });
        break;
      default:
    }
  });

  /* Links */
  for (const link of docLinks(doc)) {
    const told = localStatus(link.url);
    // An empty button is already reported above, and tags the platform fills in are as they should be.
    if (!told || told.status === "cant-check" || told.status === "empty") continue;
    if (told.status === "placeholder" && link.url === UNSUBSCRIBE_PLACEHOLDER) continue;
    const id = `link:${link.blockId}:${link.url}`;
    if (told.status === "not-https") {
      const secure = link.url.replace(/^http:\/\//i, "https://");
      const block = blocks.find((b) => b.id === link.blockId);
      // Where the address sits depends on the kind of block; text and pasted HTML hold it inside their HTML.
      const patch: Record<string, unknown> | null = !block
        ? null
        : block.type === "button" || block.type === "video"
          ? { url: secure }
          : block.type === "heading" || block.type === "paragraph" || block.type === "code"
            ? {
                html: block.html
                  .split(`href="${link.url.replace(/&/g, "&amp;")}"`)
                  .join(`href="${secure.replace(/&/g, "&amp;")}"`),
              }
            : null;
      add({
        id,
        rule: "link-http",
        level: "warn",
        title: `A link starts with http:// (${link.label}).`,
        detail:
          "Links in the email must start with https://, or they are left out. Most sites work at the same address with https://; check it after changing.",
        blockId: link.blockId,
        ...(patch
          ? {
              fix: [{ type: "updateBlock", id: link.blockId, patch }] as DocAction[],
              fixLabel: "Change it to https://",
            }
          : {}),
      });
    } else {
      add({
        id,
        rule: `link-${told.status}`,
        level: "error",
        title:
          told.status === "placeholder"
            ? `A link still needs a real address (${link.label}).`
            : `A link cannot be used (${link.label}).`,
        detail: told.reason ?? "",
        blockId: link.blockId,
      });
    }
  }

  /* Size */
  const bytes = htmlBytes(renderDocHtml(doc));
  const kb = Math.round(bytes / 1024);
  if (bytes > SIZE_LIMIT)
    add({
      id: "size-over",
      rule: "size",
      level: "error",
      title: "The email is too big: Gmail will cut it off.",
      detail: `It is ${kb} KB and Gmail stops at ${Math.round(SIZE_LIMIT / 1024)} KB, hiding the rest behind a link. Remove some content.`,
    });
  else if (bytes > SIZE_LIMIT * 0.8)
    add({
      id: "size-near",
      rule: "size",
      level: "warn",
      title: "The email is close to the size where Gmail cuts it off.",
      detail: `It is ${kb} KB of the ${Math.round(SIZE_LIMIT / 1024)} KB Gmail shows. Consider removing a little.`,
    });

  const order: Record<SuggestionLevel, number> = { error: 0, warn: 1, tip: 2 };
  return out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => order[a.s.level] - order[b.s.level] || a.i - b.i)
    .map((x) => x.s);
}

/** Things to check before sending: every finding that is more than a tip, as one line each. */
export function docChecks(doc: EmailDoc): string[] {
  return [
    ...new Set(
      optimize(doc)
        .filter((s) => s.level !== "tip")
        .map((s) => s.title),
    ),
  ];
}
