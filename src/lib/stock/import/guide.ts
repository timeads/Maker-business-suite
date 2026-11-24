import type { ImportKind } from "./files";

/**
 * What each spreadsheet is and which columns it takes, in the words shown on
 * the import page. The readers in `files.ts` are what actually decide; a test
 * keeps the two in step. docs/stock-import.md says how to get each file out
 * of TuftStock.
 */
export type ImportGuide = {
  title: string;
  about: string;
  /** How rows find what they belong to. */
  matchedBy: string;
  columns: { name: string; needed?: boolean; about: string }[];
};

/** The order to bring files in: later ones lean on earlier ones. */
export const IMPORT_ORDER: ImportKind[] = [
  "suppliers",
  "items",
  "orders",
  "deliveries",
  "ledger",
  "counts",
];

const ITEM_COLUMNS = [
  { name: "sku", needed: true, about: "The item's SKU in your shop" },
  { name: "product", about: "The product's name, used when there is no SKU to go by" },
  { name: "option", about: "The option's name (size, colour), with product" },
];

export const IMPORT_GUIDE: Record<ImportKind, ImportGuide> = {
  suppliers: {
    title: "Suppliers",
    about: "Who you buy from, who to write to, how long they take and their smallest order.",
    matchedBy: "Matched by name, whatever the capitals. A supplier that isn't here yet is added.",
    columns: [
      { name: "name", needed: true, about: "The supplier's name" },
      { name: "contact_name", about: "Who the order is addressed to" },
      { name: "contact_email", about: "One address or several, with ; between them" },
      { name: "lead_time_days", about: "Days from ordering to having it; empty leaves it alone" },
      { name: "coverage_days", about: "Days of sales one order should cover" },
      { name: "moq", about: "Smallest order" },
      { name: "moq_applies_to", about: "ORDER (across the whole order) or SKU (each item)" },
      { name: "payment_terms_days", about: "Days from an invoice until it is due" },
      { name: "notes", about: "Anything else" },
      { name: "archived", about: "yes for a supplier you no longer use" },
    ],
  },
  items: {
    title: "Item planning",
    about: "Each item's supplier and planning figures. Your shop's own details aren't touched.",
    matchedBy:
      "Matched by SKU, else by product and option. A column that is in the file is set on every row (an empty cell clears it); a column that isn't is left alone.",
    columns: [
      ...ITEM_COLUMNS,
      { name: "supplier", about: "Who it comes from; empty leaves it with whoever it has" },
      { name: "supplier_sku", about: "What the supplier calls it" },
      { name: "own_cost", about: "What one costs you, when you know better than the shop" },
      { name: "lead_time_days", about: "This item's own lead time" },
      { name: "coverage_days", about: "This item's own days of cover" },
      { name: "safety_stock", about: "Spare units to keep" },
      { name: "moq", about: "This item's own smallest order" },
      { name: "case_pack", about: "Units in a case" },
      { name: "dont_reorder", about: "yes stops suggestions; the item stays in your lists" },
      { name: "hidden", about: "yes takes it out of your lists and out of planning" },
    ],
  },
  orders: {
    title: "Purchase orders",
    about:
      "Past and open orders, one row for each line. What a file says has already arrived is kept as history: it never raises a count and is never sent to your shop.",
    matchedBy:
      "Rows with the same reference make one order. An order whose reference is already here is left exactly as it is.",
    columns: [
      { name: "reference", needed: true, about: "The order's name, the same on each of its rows" },
      { name: "supplier", needed: true, about: "Who it was placed with" },
      {
        name: "status",
        about: "DRAFT, ORDERED, PARTIAL, CLOSED or ARCHIVED; empty and we work it out",
      },
      { name: "created_at", about: "When it was started" },
      { name: "sent_at", about: "When it was sent" },
      { name: "expected_at", about: "When it is due" },
      { name: "closed_at", about: "When it was finished" },
      ...ITEM_COLUMNS,
      { name: "qty_ordered", needed: true, about: "How many were ordered" },
      { name: "qty_received", about: "How many had arrived" },
      { name: "unit_cost", about: "Cost of one" },
      { name: "supplier_sku", about: "The supplier's code on this line" },
      { name: "shipping_cost", about: "Shipping for the whole order" },
      { name: "tax_rate_pct", about: "Tax as a percentage of the items" },
      { name: "adjustments", about: "Other amounts, written Label=12.50; Other=-3.00" },
      { name: "notes", about: "The order's note" },
    ],
  },
  deliveries: {
    title: "Past deliveries",
    about:
      "When goods on those orders arrived, so we can tell how long each supplier really takes. History only.",
    matchedBy:
      "Each row is matched to an order you brought in from a spreadsheet, by its reference and item. Bring the orders in first.",
    columns: [
      { name: "reference", needed: true, about: "The order it arrived on" },
      ...ITEM_COLUMNS,
      { name: "quantity", needed: true, about: "How many arrived" },
      { name: "received_at", needed: true, about: "The day, or the day and time" },
    ],
  },
  ledger: {
    title: "Supplier ledger",
    about: "Invoices, payments, the supplier's own statements and credits, for the Balances tab.",
    matchedBy:
      "An invoice or payment with a number corrects the entry that already has that number. Anything else is added unless the very same entry is already here.",
    columns: [
      { name: "supplier", needed: true, about: "Whose account it is" },
      { name: "type", needed: true, about: "STATEMENT, INVOICE, PAYMENT or ADJUSTMENT" },
      { name: "entry_date", needed: true, about: "The date on it" },
      { name: "amount", about: "For an invoice, payment or adjustment (a credit is negative)" },
      { name: "stated_balance", about: "For a statement: what the supplier says is owed" },
      { name: "reference", about: "Invoice number or payment reference" },
      { name: "description", about: "A note" },
      { name: "paid_on", about: "For an invoice you have marked as paid: when" },
    ],
  },
  counts: {
    title: "Past daily counts",
    about:
      "What was on the shelf on past days, so days you were sold out are left out of the sales rate from the start.",
    matchedBy:
      "One row for an item on a day. Only the last 200 days are used, and a day this app already has a count for keeps it.",
    columns: [
      ...ITEM_COLUMNS,
      { name: "date", needed: true, about: "The day" },
      { name: "on_hand", needed: true, about: "The count that day" },
    ],
  },
};
