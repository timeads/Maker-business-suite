/** Pure helpers for the Messages screens: names, grouping, mentions, links. */

export type Person = { user_id: string; email: string; display_name: string | null };

/** "kim.lee@shop.com" → "Kim Lee", unless they chose a name themselves. */
export function nameOf(person: Pick<Person, "email" | "display_name"> | undefined): string {
  if (!person) return "Someone";
  if (person.display_name?.trim()) return person.display_name.trim();
  const local = person.email.split("@")[0] ?? "";
  const words = local.split(/[._+-]+/).filter(Boolean);
  if (words.length === 0) return person.email;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

export function initials(name: string): string {
  // Letters and digits only, so "Jo (studio)" is JS, not J(.
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const letters =
    words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

/** The @handles that point at a person: their first name and the start of their email. */
export function handlesFor(person: Person): string[] {
  const first = nameOf(person).split(/\s+/)[0]?.toLowerCase() ?? "";
  const local = (person.email.split("@")[0] ?? "").toLowerCase();
  return [...new Set([first, local].filter((h) => h.length > 0))];
}

export type Piece =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "mention"; text: string; me: boolean };

const TOKEN = /(https?:\/\/[^\s<>"']+)|(@[a-z0-9][a-z0-9._-]*)/gi;

/**
 * Splits a message into text, links and mentions. Nothing here produces
 * markup: the caller renders each piece as a text node or a plain link.
 */
export function splitBody(body: string, people: Person[], myId: string): Piece[] {
  const byHandle = new Map<string, Person>();
  for (const person of people) {
    for (const handle of handlesFor(person)) {
      if (!byHandle.has(handle)) byHandle.set(handle, person);
    }
  }
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    let token = match[0];
    let piece: Piece | null = null;
    if (match[1]) {
      // Sentence punctuation right after a link isn't part of it.
      token = token.replace(/[.,;:!?)\]]+$/, "");
      piece = { kind: "link", text: token, href: token };
    } else {
      const handle = token
        .slice(1)
        .toLowerCase()
        .replace(/[._-]+$/, "");
      const person = byHandle.get(handle);
      if (person) {
        token = token.slice(0, handle.length + 1);
        piece = {
          kind: "mention",
          text: `@${nameOf(person).split(/\s+/)[0]}`,
          me: person.user_id === myId,
        };
      }
    }
    if (!piece) continue;
    if (index > last) pieces.push({ kind: "text", text: body.slice(last, index) });
    pieces.push(piece);
    last = index + token.length;
  }
  if (last < body.length) pieces.push({ kind: "text", text: body.slice(last) });
  return pieces;
}

export const mentionsMe = (body: string, people: Person[], myId: string) =>
  splitBody(body, people, myId).some((p) => p.kind === "mention" && p.me);

export type ChatMessage = {
  id: number;
  channel_id: string;
  author_id: string | null;
  app: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
};

export type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ChatMessage; head: boolean };

const dayKey = (instant: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));

function dayLabel(key: string, todayKey: string): string {
  if (key === todayKey) return "Today";
  const [y, m, d] = key.split("-").map(Number);
  const [ty, tm, td] = todayKey.split("-").map(Number);
  const diff = (Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86_400_000;
  if (diff === 1) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(y === ty ? {} : { year: "numeric" }),
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Lays messages out for reading: a divider when the day changes, and a run
 * of messages from one author within five minutes shares a single heading.
 */
export function layoutMessages(messages: ChatMessage[], timeZone: string, now: Date): Row[] {
  const today = dayKey(now.toISOString(), timeZone);
  const rows: Row[] = [];
  let previous: ChatMessage | null = null;
  let previousDay = "";
  for (const message of messages) {
    const day = dayKey(message.created_at, timeZone);
    if (day !== previousDay) {
      rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(day, today) });
      previous = null;
    }
    const sameAuthor =
      previous !== null &&
      previous.author_id === message.author_id &&
      previous.app === message.app &&
      Date.parse(message.created_at) - Date.parse(previous.created_at) < 5 * 60_000;
    rows.push({ kind: "message", key: `m-${message.id}`, message, head: !sameAuthor });
    previous = message;
    previousDay = day;
  }
  return rows;
}

export function timeLabel(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(instant),
  );
}

const APP_NAMES: Record<string, string> = {
  bookings: "Bookings",
  helpdesk: "Help desk",
  social: "Social",
  money: "Money",
  stock: "Stock",
  shipping: "Shipping",
};
export const appName = (app: string) => APP_NAMES[app] ?? app[0].toUpperCase() + app.slice(1);
