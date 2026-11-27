import type { BookingImportKind } from "./files";

/**
 * What each bookings spreadsheet is and which columns it takes, in the words
 * shown on the import page. The readers in `files.ts` decide; a test keeps
 * the two in step. docs/bookings-import.md says how to make each file from
 * the earlier booking app.
 */
export type BookingImportGuide = {
  title: string;
  about: string;
  matchedBy: string;
  columns: { name: string; needed?: boolean; about: string }[];
};

/** Later files lean on earlier ones. */
export const BOOKING_IMPORT_ORDER: BookingImportKind[] = ["workshops", "dates", "bookings"];

export const BOOKING_IMPORT_GUIDE: Record<BookingImportKind, BookingImportGuide> = {
  workshops: {
    title: "Workshops",
    about:
      "What you teach: its name, length, usual places, where it happens and the shop product that sells it.",
    matchedBy:
      "Matched by the id from your earlier app, else by its shop product, else by name. A column that isn't in the file is left alone.",
    columns: [
      { name: "id", about: "The workshop's id in your earlier app, so dates can point at it" },
      { name: "name", needed: true, about: "The workshop's name (title is fine too)" },
      { name: "description", about: "What people will make" },
      { name: "duration_minutes", about: "How long it runs, in minutes" },
      { name: "capacity", about: "Usual places on a date (default_capacity is fine too)" },
      {
        name: "price",
        about:
          "Price per place, for booking on your own pages; leave it out for shop-sold workshops",
      },
      { name: "location", about: "Where it happens, shown to customers" },
      { name: "shopify_product_id", about: "The shop product that sells it" },
      { name: "shopify_variant_id", about: "The variant to put in the cart" },
      { name: "active", about: "no for a workshop you no longer run" },
    ],
  },
  dates: {
    title: "Dates",
    about:
      "Each date a workshop runs, with its places and whether it is private, closed or cancelled.",
    matchedBy:
      "A date keeps its id from your earlier app, so carts and orders that carry it still land on it. Otherwise matched by workshop and start.",
    columns: [
      {
        name: "id",
        about: "The date's id in your earlier app: the “Session ID” in carts and orders",
      },
      {
        name: "workshop_id",
        needed: true,
        about: "The workshop's id from the workshops file (or workshop, its name)",
      },
      { name: "workshop", about: "The workshop's name, when there's no workshop_id" },
      { name: "starts_at", needed: true, about: "Day and time it starts" },
      { name: "ends_at", about: "When it ends; empty means the workshop's length" },
      { name: "capacity", about: "Places on this date" },
      { name: "status", about: "scheduled, full, completed or cancelled" },
      { name: "bookings_closed", about: "yes when it stopped taking bookings" },
      { name: "private", about: "yes for a private class" },
      { name: "notes", about: "A note for the team" },
      {
        name: "shared_group",
        about: "The same word or id on dates that share one room (capacity_group_id)",
      },
      { name: "shared_capacity", about: "Places the room holds between them" },
    ],
  },
  bookings: {
    title: "Bookings",
    about:
      "Who booked which date. Nobody is emailed; what your earlier app already sent is noted so it isn't sent again.",
    matchedBy:
      "Matched by the id from your earlier app, else by shop order and date. A booking the shop sync has already made is matched, not doubled.",
    columns: [
      { name: "id", about: "The booking's id in your earlier app" },
      { name: "session_id", needed: true, about: "The date's id, as in the dates file" },
      { name: "customer_name", about: "Their name" },
      { name: "customer_email", about: "Their email, for reminders" },
      { name: "customer_phone", about: "Their phone number, kept for you" },
      { name: "sms_opt_in", about: "yes if they agreed to text messages" },
      { name: "seats", needed: true, about: "Places booked, 1 to 50" },
      { name: "status", about: "confirmed, attended, no_show or cancelled" },
      { name: "source", about: "shopify, manual or eventbrite" },
      { name: "shopify_order_id", about: "The shop order's id, so refunds still follow it" },
      { name: "shopify_order_number", about: "The order number people see, like #1042" },
      { name: "notes", about: "Your note on the booking" },
      { name: "tags", about: "Tags, with ; between them" },
      { name: "email_opt_in", about: "no if this booking's emails were switched off" },
      { name: "created_at", about: "When they booked" },
      { name: "cancelled_at", about: "When it was cancelled" },
      { name: "reminder_sent_at", about: "When the reminder went, if it did" },
      { name: "day_of_sent_at", about: "When the day-of reminder went, if it did" },
      { name: "followup_sent_at", about: "When the thank-you went, if it did" },
      {
        name: "reminder_text_sent_at",
        about: "When the reminder text went; empty counts as gone if the reminder email went",
      },
      { name: "day_of_text_sent_at", about: "When the day-of reminder text went, if it did" },
      { name: "followup_text_sent_at", about: "When the thank-you text went, if it did" },
      { name: "amount_paid", about: "What they paid, if you know" },
    ],
  },
};
