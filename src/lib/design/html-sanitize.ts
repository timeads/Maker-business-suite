// HTML pasted into a Code block, made safe to show in the builder and to send. Nothing is
// trusted: the text is read one piece at a time and written out again from scratch, keeping only
// the tags, attributes, addresses and styles on the lists below. What is not on a list never
// reaches the output, so there is nothing to slip through by being written oddly.
//
// It runs when the HTML is typed or pasted and again when the email is exported.
//
// Pure: no DOM, no network and no Deno APIs.

import { UNSUBSCRIBE_PLACEHOLDER } from "./email";

export const MAX_CODE = 20000;

const KEPT = new Set([
  "table",
  "tbody",
  "thead",
  "tr",
  "td",
  "th",
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "a",
  "img",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "sup",
  "sub",
  "blockquote",
  "center",
  "font",
]);
const VOID = new Set(["br", "hr", "img"]);
// Elements whose insides are code or another document, never words for the reader: they go, contents and all.
const DROPPED_WHOLE = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "noscript",
  "template",
  "title",
  "head",
  "textarea",
  "select",
  "button",
  "xmp",
  "plaintext",
  "listing",
  "noembed",
  "noframes",
  "frameset",
  "applet",
  "audio",
  "video",
  "canvas",
]);
const ATTRS = new Set([
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "align",
  "valign",
  "style",
  "class",
  "colspan",
  "rowspan",
  "cellpadding",
  "cellspacing",
  "border",
  "bgcolor",
  "color",
  "role",
  "target",
  "rel",
]);
const MAX_DEPTH = 60;

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/y;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  tab: "\t",
  newline: "\n",
  colon: ":",
  sol: "/",
  semi: ";",
  lpar: "(",
  rpar: ")",
  period: ".",
  comma: ",",
};
/**
 * An attribute's value with its character references read, as a browser would read them, so that
 * what is judged is what the browser would act on. A reference with its semicolon left off is
 * read too, since browsers do.
 */
function decode(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,30});?/g,
    (whole, ref: string) => {
      if (ref[0] === "#") {
        const code =
          ref[1] === "x" || ref[1] === "X"
            ? parseInt(ref.slice(2), 16)
            : parseInt(ref.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      }
      return NAMED[ref.toLowerCase()] ?? whole;
    },
  );
}

/**
 * Whether text holds a control character (always), or, for an address, a space or one of the
 * invisible characters that can hide what an address really is.
 */
function hasOdd(text: string, address: boolean): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
    if (
      address &&
      (c === 0x20 ||
        (c > 0x7f && c <= 0x9f) ||
        (c >= 0x200b && c <= 0x200f) ||
        c === 0x2028 ||
        c === 0x2029 ||
        c === 0xfeff)
    )
      return true;
  }
  return false;
}

const MERGE_TAGS = new Set(["{{ unsubscribe_link }}", UNSUBSCRIBE_PLACEHOLDER]);

/** An address for a link or a picture, or "" when it is not one that may be used. */
function address(decoded: string, kind: "href" | "src"): string {
  const v = decoded.trim();
  // An address with a space, a line break or any control character in it is refused outright: browsers skip some of these inside "javascript:".
  if (v === "" || v.length > 2000 || (v !== "{{ unsubscribe_link }}" && hasOdd(v, true))) return "";
  if (kind === "href" && MERGE_TAGS.has(v)) return v;
  if (/[<>"'`\\]/.test(v)) return "";
  if (/^https?:\/\/[^/]/i.test(v)) return v;
  if (kind === "href" && (/^mailto:[^/]/i.test(v) || /^tel:[0-9+(). -]{3,30}$/i.test(v))) return v;
  return "";
}

const BANNED_CSS =
  /expression|javascript|vbscript|behaviou?r|binding|@import|@charset|@font-face|<|>|\\|&#|!ie|\/\*|\*\//i;

/** A style attribute with only plain declarations kept. Returns the cleaned style and whether anything went. */
function style(decoded: string): { css: string; cut: boolean } {
  const kept: string[] = [];
  let cut = false;
  // A style written over several lines is the same style on one.
  for (const piece of decoded.replace(/[\t\n\r ]+/g, " ").split(";")) {
    const at = piece.indexOf(":");
    if (piece.trim() === "") continue;
    const prop = piece.slice(0, at).trim().toLowerCase();
    const value = piece.slice(at + 1).trim();
    const urls = value.match(/url\s*\(/gi) ?? [];
    // A picture in a style may only come from a secure web address, written plainly.
    const safeUrls = value.match(/url\(\s*(['"]?)https:\/\/[^\s'"()<>\\]+\1\s*\)/gi) ?? [];
    const ok =
      at > 0 &&
      /^[a-z-]{1,40}$/.test(prop) &&
      value !== "" &&
      value.length <= 500 &&
      !hasOdd(value, false) &&
      !BANNED_CSS.test(value) &&
      !BANNED_CSS.test(prop) &&
      urls.length === safeUrls.length &&
      !(prop === "position" && /fixed|absolute|sticky/i.test(value)) &&
      !/^-moz-|^-ms-|^-o-/.test(prop);
    if (ok) kept.push(`${prop}:${value}`);
    else cut = true;
  }
  return { css: kept.join(";"), cut };
}

/** One attribute made safe, as the text to write out, or "" to leave it off. */
function attribute(tag: string, name: string, raw: string, removed: Set<string>): string {
  const value = decode(raw);
  const out = (v: string) => ` ${name}="${esc(v)}"`;
  switch (name) {
    case "href":
    case "src": {
      if ((name === "href") !== (tag === "a") || (name === "src" && tag !== "img")) return "";
      const ok = address(value, name);
      if (!ok)
        removed.add(
          name === "href"
            ? "a link that is not a web, email or phone address"
            : "a picture that is not from a web address",
        );
      return ok ? out(ok) : "";
    }
    case "style": {
      const { css, cut } = style(value);
      if (cut) removed.add("part of a style");
      return css ? out(css) : "";
    }
    case "class":
      return /^[a-zA-Z0-9_\- ]{1,200}$/.test(value) ? out(value.trim()) : "";
    case "width":
    case "height":
    case "colspan":
    case "rowspan":
    case "cellpadding":
    case "cellspacing":
    case "border":
      return /^\d{1,4}%?$/.test(value.trim()) ? out(value.trim()) : "";
    case "align":
      return /^(left|center|right|justify)$/i.test(value.trim())
        ? out(value.trim().toLowerCase())
        : "";
    case "valign":
      return /^(top|middle|bottom|baseline)$/i.test(value.trim())
        ? out(value.trim().toLowerCase())
        : "";
    case "bgcolor":
    case "color":
      return /^#?[a-zA-Z0-9]{1,20}$/.test(value.trim()) ? out(value.trim()) : "";
    case "role":
      return /^[a-z]{1,20}$/.test(value.trim()) ? out(value.trim()) : "";
    case "target":
      return tag === "a" && value.trim() === "_blank" ? out("_blank") : "";
    // Written afresh for every link that opens a new tab, below.
    case "rel":
      return "";
    default:
      return out(value.slice(0, 500)); // alt and title: any words, written out as text
  }
}

function attributes(tag: string, text: string, removed: Set<string>): string {
  const seen = new Set<string>();
  let out = "";
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(text); m; m = ATTR.exec(text)) {
    const name = m[1].toLowerCase();
    if (name === "/") continue;
    if (!ATTRS.has(name)) {
      removed.add(
        /^on/.test(name)
          ? "code that runs on a click or other event"
          : `the "${name.replace(/[^a-z0-9-]/g, "").slice(0, 20)}" setting`,
      );
      continue;
    }
    // The first of a repeated attribute is the one a browser uses.
    if (seen.has(name)) continue;
    seen.add(name);
    out += attribute(tag, name, m[2] ?? m[3] ?? m[4] ?? "", removed);
  }
  // A link that opens a new tab must not hand the new page a way back to this one.
  if (out.includes(' target="_blank"')) out += ' rel="noopener noreferrer"';
  return out;
}

export interface Sanitized {
  html: string;
  /** What was taken out, in plain words, for telling the owner. Empty when nothing was. */
  removed: string[];
}

/** HTML for a Code block with everything that is not on the allow-lists taken out. */
export function sanitizeHtml(input: unknown): Sanitized {
  let s = String(input ?? "");
  const removed = new Set<string>();
  if (s.length > MAX_CODE) {
    s = s.slice(0, MAX_CODE);
    removed.add(`everything after the first ${MAX_CODE} characters`);
  }
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;
  const close = (name: string) => {
    const at = open.lastIndexOf(name);
    if (at < 0) return;
    while (open.length > at) out.push(`</${open.pop()}>`);
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "<") {
      // Comments, including the ones Outlook reads as instructions, the doctype and anything else that starts "<!" or "<?".
      if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i + 4);
        i = end < 0 ? s.length : end + 3;
        removed.add("a comment");
        continue;
      }
      if (s[i + 1] === "!" || s[i + 1] === "?") {
        const end = s.indexOf(">", i);
        i = end < 0 ? s.length : end + 1;
        removed.add("a comment");
        continue;
      }
      TAG.lastIndex = i;
      const m = TAG.exec(s);
      if (!m) {
        out.push("&lt;");
        i += 1;
        continue;
      }
      i = TAG.lastIndex;
      const closing = m[1] === "/";
      const name = m[2].toLowerCase();
      if (DROPPED_WHOLE.has(name)) {
        if (!closing) {
          const end = new RegExp(`</${name}\\s*>`, "i").exec(s.slice(i));
          i = end ? i + end.index + end[0].length : s.length;
        }
        removed.add(
          name === "script" ? "a script" : name === "style" ? "a style sheet" : `"${name}"`,
        );
      } else if (!KEPT.has(name)) {
        // The tag goes; the words inside it stay.
        removed.add(`"${name.replace(/[^a-z0-9-]/g, "").slice(0, 20)}" tags`);
      } else if (closing) {
        if (!VOID.has(name)) close(name);
      } else if (VOID.has(name)) {
        out.push(`<${name}${attributes(name, m[3], removed)}>`);
      } else if (open.length < MAX_DEPTH) {
        // A link inside a link is not a thing; the first one is closed before the next opens.
        if (name === "a") close("a");
        out.push(`<${name}${attributes(name, m[3], removed)}>`);
        open.push(name);
      }
      continue;
    }
    if (c === "&") {
      ENTITY.lastIndex = i;
      const e = ENTITY.exec(s);
      if (e) {
        out.push(e[0]);
        i = ENTITY.lastIndex;
      } else {
        out.push("&amp;");
        i += 1;
      }
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 32 && c !== "\n" && c !== "\t" && c !== "\r") out.push("");
    else out.push(c === ">" ? "&gt;" : c === '"' ? "&quot;" : c);
    i += 1;
  }
  while (open.length) out.push(`</${open.pop()}>`);
  return { html: out.join("").trim(), removed: [...removed] };
}
