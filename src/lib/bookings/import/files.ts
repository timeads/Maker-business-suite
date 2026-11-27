import { parseCsv, type CsvRow } from "../../stock/import/csv";
import { zonedTimeToUtc } from "../slots";

/**
 * The spreadsheets a business brings its workshops, dates and bookings
 * across in, from the booking app it used before. Pure: each reader takes the
 * file's text and the workspace's timezone and gives back what would be
 * imported and what was left out, line by line and in plain words. What
 * "new" and "changed" come to is worked out in the database, by the same
 * functions that do the import (`import_booking_workshops`,
 * `import_booking_dates`, `import_bookings`).
 *
 * Column names follow the earlier app's own tables, so a file made with the
 * queries in docs/bookings-import.md comes in as it is. The same design as
 * Stock's imports (lib/stock/import), whose CSV reader this uses.
 */

export const BOOKING_IMPORT_KINDS = ["workshops", "dates", "bookings"] as const;
export type BookingImportKind = (typeof BOOKING_IMPORT_KINDS)[number];
export const isBookingImportKind = (value: string): value is BookingImportKind =>
  (BOOKING_IMPORT_KINDS as readonly string[]).includes(value);

export const MAX_BOOKING_IMPORT_BYTES = 4_000_000;
export const MAX_BOOKING_IMPORT_ROWS = 10_000;

export type Problem = { line: number; reason: string };
export type BookingImportRead =
  | {
      ok: true;
      kind: BookingImportKind;
      /** What goes to the database, already tidied; every row carries its `line`. */
      payload: Record<string, unknown>[];
      read: number;
      problems: Problem[];
      notes: string[];
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/** Other names a column may go by: the earlier app's own, and plainer ones. */
export const BOOKING_ALIASES: Record<BookingImportKind, Record<string, string[]>> = {
  workshops: {
    id: ["workshop_id"],
    name: ["title", "workshop", "workshop_name"],
    duration_minutes: ["duration", "length_minutes", "minutes"],
    capacity: ["default_capacity", "places", "seats"],
    location: ["place", "where"],
    shopify_product_id: ["shop_product_id", "product_id"],
    shopify_variant_id: ["shop_variant_id", "variant_id"],
    price: ["price_dollars"],
  },
  dates: {
    id: ["session_id", "date_id"],
    workshop_id: [],
    workshop: ["workshop_title", "workshop_name", "title"],
    starts_at: ["start", "starts", "start_time", "date"],
    ends_at: ["end", "ends", "end_time"],
    capacity: ["places", "seats"],
    shared_group: ["capacity_group_id", "shared_room"],
    shared_capacity: ["capacity_group_capacity", "group_capacity", "shared_places"],
    bookings_closed: ["closed"],
  },
  bookings: {
    id: ["booking_id"],
    session_id: ["date_id"],
    customer_name: ["name"],
    customer_email: ["email"],
    customer_phone: ["phone"],
    sms_opt_in: ["text_opt_in", "texts"],
    seats: ["places", "quantity"],
    shopify_order_id: ["shop_order_id", "order_id"],
    shopify_order_number: ["shop_order_name", "order_number", "order_name"],
    reminder_sent_at: ["reminder_48h_sent_at", "reminder_sent"],
    day_of_sent_at: ["reminder_2h_sent_at", "day_of_sent"],
    followup_sent_at: ["followup_24h_sent_at", "thank_you_sent_at", "followup_sent"],
    reminder_text_sent_at: ["reminder_48h_sms_sent_at", "reminder_sms_sent_at"],
    day_of_text_sent_at: ["reminder_2h_sms_sent_at", "day_of_sms_sent_at"],
    followup_text_sent_at: ["followup_24h_sms_sent_at", "followup_sms_sent_at"],
    amount_paid: ["paid", "amount"],
  },
};

/** The columns a file can't do without. `workshop` means a workshop id, or its name. */
const REQUIRED: Record<BookingImportKind, string[]> = {
  workshops: ["name"],
  dates: ["workshop", "starts_at"],
  bookings: ["session_id", "seats"],
};

const FILE_WORDS: Record<BookingImportKind, string> = {
  workshops: "workshops",
  dates: "dates",
  bookings: "bookings",
};

function present(kind: BookingImportKind, headers: string[]) {
  const set = new Set(headers);
  const source = (column: string): string | null =>
    [column, ...(BOOKING_ALIASES[kind][column] ?? [])].find((name) => set.has(name)) ?? null;
  const has = (column: string) => source(column) !== null;
  const needs = (column: string) =>
    kind === "dates" && column === "workshop" ? has("workshop_id") || has("workshop") : has(column);
  return { source, has, needs };
}

/** Which kind of file these headings belong to; bookings first, as they name the most. */
export function guessBookingImportKind(headers: string[]): BookingImportKind | null {
  const order: BookingImportKind[] = ["bookings", "dates", "workshops"];
  return (
    order.find((kind) => {
      const { needs } = present(kind, headers);
      return REQUIRED[kind].every(needs);
    }) ?? null
  );
}

type Row = { line: number; has: (column: string) => boolean; get: (column: string) => string };

function open(
  kind: BookingImportKind,
  text: string,
): { ok: true; rows: Row[]; has: (column: string) => boolean } | { ok: false; error: string } {
  if (new TextEncoder().encode(text).length > MAX_BOOKING_IMPORT_BYTES) {
    return {
      ok: false,
      error: `That file is bigger than ${MAX_BOOKING_IMPORT_BYTES / 1_000_000} MB. Split it into smaller files and bring them in one at a time.`,
    };
  }
  const file = parseCsv(text);
  if (!file.ok) return file;
  if (file.rows.length === 0) {
    return { ok: false, error: "That file has headings but no rows under them." };
  }
  if (file.rows.length > MAX_BOOKING_IMPORT_ROWS) {
    return {
      ok: false,
      error: `That file has ${file.rows.length.toLocaleString("en-US")} rows; the most we take at once is ${MAX_BOOKING_IMPORT_ROWS.toLocaleString("en-US")}. Split it and bring the parts in one at a time.`,
    };
  }
  const { source, has, needs } = present(kind, file.headers);
  const missing = REQUIRED[kind].filter((column) => !needs(column));
  if (missing.length > 0) {
    const names = missing.map((column) =>
      kind === "dates" && column === "workshop" ? "“workshop_id” (or “workshop”)" : `“${column}”`,
    );
    return {
      ok: false,
      error: `A ${FILE_WORDS[kind]} file needs ${names.length === 1 ? "a column called" : "columns called"} ${names.join(" and ")}. This file's columns are: ${file.headers.join(", ")}.`,
    };
  }
  const rows = file.rows.map((row: CsvRow) => ({
    line: row.line,
    has,
    get: (column: string) => {
      const from = source(column);
      return from ? (row.cells[from] ?? "") : "";
    },
  }));
  return { ok: true, rows, has };
}

// ---------------------------------------------------------------------------
// Reading one cell
// ---------------------------------------------------------------------------

class Unusable extends Error {}
const bad = (reason: string): never => {
  throw new Unusable(reason);
};

function whole(row: Row, column: string, min: number, max: number, what: string): number | null {
  const typed = row.get(column).replace(/,/g, "");
  if (typed === "") return null;
  if (!/^-?\d{1,9}$/.test(typed)) return bad(`“${row.get(column)}” isn't a whole number (${what})`);
  const value = Number(typed);
  if (value < min || value > max) {
    return bad(`${what} should be between ${min} and ${max}, not ${value}`);
  }
  return value;
}

/** "90", "$90.00", "1,200.5" → whole cents. */
function cents(row: Row, column: string, what: string): number | null {
  const typed = row.get(column).replace(/[$,\s]/g, "");
  if (typed === "") return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(typed))
    return bad(`“${row.get(column)}” isn't an amount (${what})`);
  const [units, part = ""] = typed.split(".");
  return Number(units) * 100 + Number(part.padEnd(2, "0"));
}

const YES = new Set(["true", "t", "yes", "y", "1", "x"]);
const NO = new Set(["false", "f", "no", "n", "0"]);
/** Yes or no, or null for an empty cell. */
function yesNo(row: Row, column: string): boolean | null {
  const typed = row.get(column).toLowerCase();
  if (typed === "") return null;
  if (YES.has(typed)) return true;
  if (NO.has(typed)) return false;
  return bad(`“${row.get(column)}” should be yes or no (${column})`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id from the earlier app: kept as it is, up to 100 characters. */
function ref(row: Row, column: string): string | null {
  const typed = row.get(column).trim();
  if (typed === "") return null;
  if (typed.length > 100) return bad(`The ${column} is longer than 100 characters`);
  return UUID.test(typed) ? typed.toLowerCase() : typed;
}

/** The shop's id for a product, variant or order: digits, or the shop's long "gid://…/123" form. */
function shopId(row: Row, column: string, what: string): string | null {
  const typed = row.get(column).trim();
  if (typed === "") return null;
  const digits = /^(?:gid:\/\/shopify\/[A-Za-z]+\/)?(\d{1,20})$/.exec(typed)?.[1];
  return digits ?? bad(`“${typed}” isn't a shop ${what} id (it should be a number)`);
}

const pad = (n: number) => String(n).padStart(2, "0");
const realDay = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    y >= 2000 &&
    y <= 2100 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

/**
 * A moment, as an ISO string. Read:
 *   2026-03-04T15:00:00Z, 2026-03-04 15:00:00+00, …-05:00 (a time zone given)
 *   2026-03-04 10:00, 3/4/2026 10:00 am (no zone: the workspace's own clock)
 *   2026-03-04, 3/4/2026 (only where a day is enough: noon on the workspace's clock)
 * Null when it can't be read. A time that doesn't exist on that day (the
 * hour skipped when clocks go forward) can't be read either.
 */
export function readMoment(typed: string, timeZone: string, dayIsEnough = false): string | null {
  const text = typed.trim();
  let match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
      text,
    );
  let y: number, m: number, d: number, hour: number, minute: number;
  if (match) {
    [y, m, d, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(match![i]));
    const second = Number(match[6] ?? 0);
    if (!realDay(y, m, d) || hour > 23 || minute > 59 || second > 59) return null;
    const zone = match[7];
    if (zone) {
      const offset = /^z$/i.test(zone)
        ? "Z"
        : `${zone.slice(0, 3)}:${zone.length > 3 ? zone.slice(-2) : "00"}`;
      const date = new Date(
        `${y}-${pad(m)}-${pad(d)}T${pad(hour)}:${pad(minute)}:${pad(second)}${offset}`,
      );
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    return (
      zonedTimeToUtc(`${y}-${pad(m)}-${pad(d)}`, hour * 60 + minute, timeZone)?.toISOString() ??
      null
    );
  }
  match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?)?$/i.exec(
      text,
    );
  if (match) {
    [m, d, y] = [1, 2, 3].map((i) => Number(match![i]));
    if (!realDay(y, m, d)) return null;
    if (match[4] === undefined) {
      if (!dayIsEnough) return null;
      return zonedTimeToUtc(`${y}-${pad(m)}-${pad(d)}`, 12 * 60, timeZone)?.toISOString() ?? null;
    }
    hour = Number(match[4]);
    minute = Number(match[5]);
    const half = match[6]?.toLowerCase().replace(/\./g, "");
    if (half) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (half === "pm" ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return null;
    return (
      zonedTimeToUtc(`${y}-${pad(m)}-${pad(d)}`, hour * 60 + minute, timeZone)?.toISOString() ??
      null
    );
  }
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match && dayIsEnough) {
    [y, m, d] = [1, 2, 3].map((i) => Number(match![i]));
    if (!realDay(y, m, d)) return null;
    return zonedTimeToUtc(`${y}-${pad(m)}-${pad(d)}`, 12 * 60, timeZone)?.toISOString() ?? null;
  }
  return null;
}

function moment(row: Row, column: string, timeZone: string, what: string, dayIsEnough = false) {
  const typed = row.get(column);
  if (typed.trim() === "") return null;
  return (
    readMoment(typed, timeZone, dayIsEnough) ??
    bad(
      `“${typed}” isn't a ${dayIsEnough ? "date" : "date and time"} we can read (${what}). Write it like 2026-03-04 10:00`,
    )
  );
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** "{gift,returning}" (as a database writes a list), or "gift; returning". */
export function readTags(typed: string): string[] {
  const inner = typed.trim().replace(/^\{|\}$/g, "");
  const tags = inner
    .split(/[;,]/)
    .map((tag) => tag.trim().replace(/^"|"$/g, "").toLowerCase())
    .filter((tag) => /^[a-z0-9][a-z0-9 _-]{0,29}$/.test(tag));
  return [...new Set(tags)].slice(0, 20);
}

function text(row: Row, column: string, max: number, what: string): string {
  const value = row.get(column);
  if (value.length > max)
    return bad(`${what} is longer than ${max.toLocaleString("en-US")} characters`);
  return value;
}

/** Runs `read` for every row; a row it throws on is left out with the reason. */
function eachRow<T>(rows: Row[], problems: Problem[], read: (row: Row) => T | null): T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      const value = read(row);
      if (value !== null) out.push(value);
    } catch (err) {
      if (!(err instanceof Unusable)) throw err;
      problems.push({ line: row.line, reason: err.message });
    }
  }
  return out;
}

/** A second row with the same id is left out: which one is right can't be told. */
function onceEach(seen: Set<string>, id: string | null, what: string) {
  if (id === null) return;
  const key = id.toLowerCase();
  if (seen.has(key)) bad(`This ${what}'s id is in the file twice; only the first is brought in`);
  seen.add(key);
}

// ---------------------------------------------------------------------------
// The three files
// ---------------------------------------------------------------------------

function readWorkshops(rows: Row[], has: (column: string) => boolean) {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();
  const payload = eachRow(rows, problems, (row) => {
    const id = ref(row, "id");
    onceEach(seen, id, "workshop");
    const name = row.get("name").replace(/\s+/g, " ").trim();
    if (!name) return bad("A workshop needs a name");
    if (name.length > 80) return bad("The name is longer than 80 characters");
    if (!id) {
      if (names.has(name.toLowerCase())) return bad("This workshop is in the file twice");
      names.add(name.toLowerCase());
    }
    const out: Record<string, unknown> = { line: row.line, name };
    if (id) out.ref = id;
    if (has("description")) out.description = text(row, "description", 2000, "The description");
    const duration = whole(row, "duration_minutes", 5, 1440, "length in minutes");
    if (duration !== null) out.duration_minutes = duration;
    const capacity = whole(row, "capacity", 1, 500, "places");
    if (capacity !== null) out.capacity = capacity;
    const price = cents(row, "price", "price");
    if (price !== null) out.price_cents = price;
    if (has("location"))
      out.location = text(row, "location", 200, "The place").replace(/\s+/g, " ");
    const product = shopId(row, "shopify_product_id", "product");
    if (product) {
      out.shop_product_id = product;
      const variant = shopId(row, "shopify_variant_id", "variant");
      if (variant) out.shop_variant_id = variant;
    }
    const active = yesNo(row, "active");
    if (active !== null) out.active = active;
    return out;
  });
  return { payload, problems, notes: [] as string[] };
}

const DATE_STATUSES = new Set(["scheduled", "full", "completed", "cancelled", "canceled"]);

function readDates(rows: Row[], has: (column: string) => boolean, timeZone: string) {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  let keptIds = 0;
  const payload = eachRow(rows, problems, (row) => {
    const id = ref(row, "id");
    onceEach(seen, id, "date");
    const workshopId = ref(row, "workshop_id");
    const workshopName = row.get("workshop").trim();
    if (!workshopId && !workshopName) return bad("Which workshop is this date for?");
    const startsAt = moment(row, "starts_at", timeZone, "start");
    if (!startsAt) return bad("A date needs a start (starts_at)");
    const endsAt = moment(row, "ends_at", timeZone, "end");
    if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      return bad("It ends before it starts");
    }
    const out: Record<string, unknown> = { line: row.line, starts_at: startsAt };
    if (id) {
      out.ref = id;
      if (UUID.test(id)) {
        out.keep_id = id;
        keptIds += 1;
      }
    }
    if (workshopId) out.workshop_ref = workshopId;
    if (workshopName) out.workshop_name = workshopName;
    if (endsAt) out.ends_at = endsAt;
    const capacity = whole(row, "capacity", 1, 500, "places");
    if (capacity !== null) out.capacity = capacity;
    if (has("status")) {
      const status = row.get("status").trim().toLowerCase();
      if (status && !DATE_STATUSES.has(status)) {
        return bad(
          `“${row.get("status")}” isn't a status we know (scheduled, full, completed or cancelled)`,
        );
      }
      out.cancelled = status === "cancelled" || status === "canceled";
    }
    const closed = yesNo(row, "bookings_closed");
    if (closed !== null) out.bookings_closed = closed;
    const hidden = yesNo(row, "private");
    if (hidden !== null) out.private = hidden;
    if (has("notes")) out.notes = text(row, "notes", 2000, "The note");
    const group = ref(row, "shared_group");
    if (group) {
      out.shared_group = group;
      const shared = whole(row, "shared_capacity", 1, 1000, "shared places");
      if (shared === null) return bad("A shared room needs its number of places (shared_capacity)");
      out.shared_capacity = shared;
    }
    return out;
  });
  const notes =
    keptIds > 0
      ? [
          `${keptIds === 1 ? "1 date keeps its" : `${keptIds} dates keep their`} id from your earlier app, so carts and orders that already carry it land on the right date.`,
        ]
      : [];
  return { payload, problems, notes };
}

const BOOKING_STATUSES: Record<string, { status: string; attendance: string | null }> = {
  confirmed: { status: "confirmed", attendance: null },
  booked: { status: "confirmed", attendance: null },
  attended: { status: "confirmed", attendance: "attended" },
  no_show: { status: "confirmed", attendance: "no_show" },
  "no-show": { status: "confirmed", attendance: "no_show" },
  noshow: { status: "confirmed", attendance: "no_show" },
  cancelled: { status: "cancelled", attendance: null },
  canceled: { status: "cancelled", attendance: null },
};

function readBookings(rows: Row[], timeZone: string) {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  let noEmail = 0;
  let fromEventbrite = 0;
  const payload = eachRow(rows, problems, (row) => {
    const id = ref(row, "id");
    onceEach(seen, id, "booking");
    const sessionRef = ref(row, "session_id");
    if (!sessionRef) return bad("Which date is this booking on? (session_id)");
    const seats = whole(row, "seats", 1, 50, "places");
    if (seats === null) return bad("How many places? (seats)");
    const email = row.get("customer_email").trim().toLowerCase();
    if (email && (!EMAIL.test(email) || email.length > 200)) {
      return bad(`“${row.get("customer_email")}” isn't an email address`);
    }
    const name = text(row, "customer_name", 120, "The name").replace(/\s+/g, " ").trim();
    if (!name && !email) return bad("A booking needs a name or an email address");
    const typedStatus = row.get("status").trim().toLowerCase() || "confirmed";
    const status = BOOKING_STATUSES[typedStatus];
    if (!status) {
      return bad(
        `“${row.get("status")}” isn't a status we know (confirmed, attended, no_show or cancelled)`,
      );
    }
    const source = row.get("source").trim().toLowerCase();
    if (source && !["shopify", "manual", "eventbrite", "online", "shop"].includes(source)) {
      return bad(`“${row.get("source")}” isn't a source we know (shopify, manual or eventbrite)`);
    }
    const phone = row.get("customer_phone").replace(/\s+/g, " ").trim();
    if (phone.length > 40 || (phone && !/^[0-9+().\-\s/x#*]+$/i.test(phone))) {
      return bad(`“${row.get("customer_phone")}” doesn't look like a phone number`);
    }
    const orderId = shopId(row, "shopify_order_id", "order");
    const tags = readTags(row.get("tags"));
    if (source === "eventbrite") {
      fromEventbrite += 1;
      if (!tags.includes("eventbrite")) tags.push("eventbrite");
    }
    if (!email) noEmail += 1;
    return {
      line: row.line,
      ref: id,
      session_ref: sessionRef,
      name,
      email,
      phone,
      text_opt_in: yesNo(row, "sms_opt_in") ?? false,
      seats,
      status: status.status,
      attendance: status.attendance,
      source: orderId ? "online" : "manual",
      tags,
      shop_order_id: orderId,
      shop_order_name: text(row, "shopify_order_number", 40, "The order number").trim() || null,
      notes: text(row, "notes", 2000, "The note"),
      email_opt_in: yesNo(row, "email_opt_in") ?? true,
      created_at: moment(row, "created_at", timeZone, "booked on", true),
      cancelled_at: moment(row, "cancelled_at", timeZone, "cancelled on", true),
      reminder_sent_at: moment(row, "reminder_sent_at", timeZone, "reminder sent", true),
      day_of_sent_at: moment(row, "day_of_sent_at", timeZone, "day-of reminder sent", true),
      followup_sent_at: moment(row, "followup_sent_at", timeZone, "thank-you sent", true),
      reminder_text_sent_at: moment(
        row,
        "reminder_text_sent_at",
        timeZone,
        "reminder text sent",
        true,
      ),
      day_of_text_sent_at: moment(
        row,
        "day_of_text_sent_at",
        timeZone,
        "day-of reminder text sent",
        true,
      ),
      followup_text_sent_at: moment(
        row,
        "followup_text_sent_at",
        timeZone,
        "thank-you text sent",
        true,
      ),
      amount_cents: cents(row, "amount_paid", "amount paid"),
    };
  });
  const notes: string[] = [
    "Nobody is emailed or texted when these come in. Reminders and thank-yous your earlier app already sent, by email or text, are noted so they aren't sent again, and no thank-you goes out for a class that has already happened. Where the file doesn't say whether a text went, a message whose email went counts as gone for the text too.",
  ];
  if (noEmail > 0) {
    notes.push(
      `${noEmail === 1 ? "1 booking has" : `${noEmail} bookings have`} no email address, so ${noEmail === 1 ? "it won't" : "they won't"} get reminders.`,
    );
  }
  if (fromEventbrite > 0) {
    notes.push(
      `${fromEventbrite === 1 ? "1 booking came" : `${fromEventbrite} bookings came`} through Eventbrite; ${fromEventbrite === 1 ? "it comes" : "they come"} in as added by you, tagged “eventbrite”.`,
    );
  }
  return { payload, problems, notes };
}

export function readBookingImport(
  kind: BookingImportKind,
  input: string,
  context: { timeZone: string },
): BookingImportRead {
  const file = open(kind, input);
  if (!file.ok) return file;
  const { rows, has } = file;
  const result =
    kind === "workshops"
      ? readWorkshops(rows, has)
      : kind === "dates"
        ? readDates(rows, has, context.timeZone)
        : readBookings(rows, context.timeZone);
  return { ok: true, kind, read: rows.length, ...result };
}

/** Every column each reader looks at (by its main name). The guide is kept to these by a test. */
export const BOOKING_COLUMNS: Record<BookingImportKind, string[]> = {
  workshops: [
    "id",
    "name",
    "description",
    "duration_minutes",
    "capacity",
    "price",
    "location",
    "shopify_product_id",
    "shopify_variant_id",
    "active",
  ],
  dates: [
    "id",
    "workshop_id",
    "workshop",
    "starts_at",
    "ends_at",
    "capacity",
    "status",
    "bookings_closed",
    "private",
    "notes",
    "shared_group",
    "shared_capacity",
  ],
  bookings: [
    "id",
    "session_id",
    "customer_name",
    "customer_email",
    "customer_phone",
    "sms_opt_in",
    "seats",
    "status",
    "source",
    "shopify_order_id",
    "shopify_order_number",
    "notes",
    "tags",
    "email_opt_in",
    "created_at",
    "cancelled_at",
    "reminder_sent_at",
    "day_of_sent_at",
    "followup_sent_at",
    "reminder_text_sent_at",
    "day_of_text_sent_at",
    "followup_text_sent_at",
    "amount_paid",
  ],
};
