import { splitCents, toCents } from "../../dashboard/lines";
import type { BookInvoiceRow } from "../types";

/**
 * Invoices, as QuickBooks records them, for Money's invoice list and for
 * revenue by line. Pure: the questions to ask and how to read the answers.
 * Read-only: nothing is ever written to the books.
 *
 * An invoice's sales lines name an item; the income account an item is
 * booked to comes from the item list (one more read-only question on the
 * same permission), or from the line itself where the books put it there.
 * The invoice before tax is shared among its sales lines by what each line
 * is for, to the cent (`splitCents`), so discounts and shipping lines fall
 * where the invoice puts them and the lines always add back up.
 */

/** How many invoices one question asks for, and the most questions in one sync. */
export const INVOICE_PAGE = 500;
export const INVOICE_PAGES = 40;
/** Items: up to this many per question, and this many questions. */
export const ITEM_PAGE = 1000;
export const ITEM_PAGES = 5;

const MAX_TEXT = 200;
const MAX_LINES = 50;

/** QuickBooks' query language: invoices dated on or after a day, a page at a time. */
export function invoicesQuery(since: string, page: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("since must be a plain day");
  const start = Math.max(0, Math.trunc(page)) * INVOICE_PAGE + 1;
  return `select * from Invoice where TxnDate >= '${since}' orderby TxnDate startposition ${start} maxresults ${INVOICE_PAGE}`;
}

/** The item list, a page at a time, for each item's income account. */
export function itemsQuery(page: number): string {
  const start = Math.max(0, Math.trunc(page)) * ITEM_PAGE + 1;
  return `select * from Item startposition ${start} maxresults ${ITEM_PAGE}`;
}

type Ref = { value?: unknown; name?: unknown } | null | undefined;
export type QueryAnswer = { QueryResponse?: Record<string, unknown> | null };

const text = (value: unknown, max = MAX_TEXT) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
const name = (ref: Ref) => text(ref?.name) || null;
const refId = (ref: Ref) => {
  const value = typeof ref?.value === "string" ? ref.value.trim() : "";
  return /^[A-Za-z0-9_-]{1,60}$/.test(value) ? value : null;
};
const cents = (value: unknown) =>
  typeof value === "number" || typeof value === "string" ? toCents(value) : 0;

export type ItemAccount = { ref: string | null; name: string | null };

/** Each item's income account, by the item's id. Anything unclear is left out. */
export function parseItems(answer: QueryAnswer): Map<string, ItemAccount> {
  const out = new Map<string, ItemAccount>();
  const list = answer.QueryResponse?.Item;
  if (!Array.isArray(list)) return out;
  for (const item of list as { Id?: unknown; IncomeAccountRef?: Ref }[]) {
    const id = refId({ value: item?.Id });
    if (!id || !item.IncomeAccountRef) continue;
    out.set(id, { ref: refId(item.IncomeAccountRef), name: name(item.IncomeAccountRef) });
  }
  return out;
}

type QboLine = {
  Amount?: unknown;
  Description?: unknown;
  DetailType?: unknown;
  SalesItemLineDetail?: { ItemRef?: Ref; ItemAccountRef?: Ref } | null;
};
type QboInvoice = {
  Id?: unknown;
  DocNumber?: unknown;
  TxnDate?: unknown;
  DueDate?: unknown;
  TotalAmt?: unknown;
  Balance?: unknown;
  CustomerRef?: Ref;
  CustomerMemo?: { value?: unknown } | null;
  PrivateNote?: unknown;
  TxnTaxDetail?: { TotalTax?: unknown } | null;
  Line?: unknown;
};

const plainDay = (value: unknown) => {
  const day = text(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

/** One invoice as a row for Money, or null when it isn't clear. */
export function parseInvoice(
  record: QboInvoice,
  items: ReadonlyMap<string, ItemAccount>,
): BookInvoiceRow | null {
  if (!record || typeof record !== "object") return null;
  const id = text(record.Id, 40);
  const date = plainDay(record.TxnDate);
  if (!id || !date) return null;
  const total = cents(record.TotalAmt);
  const tax = cents(record.TxnTaxDetail?.TotalTax);
  const net = total - tax;
  const raw = (Array.isArray(record.Line) ? (record.Line as QboLine[]) : [])
    .filter((line) => line && line.DetailType === "SalesItemLineDetail")
    .slice(0, MAX_LINES)
    .map((line) => {
      const itemRef = line.SalesItemLineDetail?.ItemRef;
      const fromItem = items.get(refId(itemRef) ?? "");
      const onLine = line.SalesItemLineDetail?.ItemAccountRef;
      return {
        account_ref: refId(onLine) ?? fromItem?.ref ?? null,
        account: name(onLine) ?? fromItem?.name ?? null,
        item: name(itemRef),
        weight: cents(line.Amount),
        description: text(line.Description),
      };
    });
  // Shared by what each line is for; with nothing to weigh, one line holds it.
  const shares = splitCents(
    net,
    raw.map((line) => line.weight),
  );
  const lines =
    raw.length === 0 || shares.length !== raw.length
      ? [
          {
            account_ref: raw.length === 1 ? raw[0].account_ref : null,
            account: raw.length === 1 ? raw[0].account : null,
            item: raw.length === 1 ? raw[0].item : null,
            cents: net,
            description: raw.length === 1 ? raw[0].description : "",
          },
        ]
      : raw.map(({ weight: _weight, ...line }, index) => ({ ...line, cents: shares[index] }));
  return {
    external_id: id,
    doc_number: text(record.DocNumber, 40) || null,
    customer: name(record.CustomerRef),
    date,
    due_date: plainDay(record.DueDate),
    total_cents: total,
    balance_cents: cents(record.Balance),
    net_cents: net,
    memo: text(record.CustomerMemo?.value, 300) || text(record.PrivateNote, 300),
    lines,
  };
}

/** The invoices in an answer, as rows. Anything unclear is left out. */
export function parseInvoices(
  answer: QueryAnswer,
  items: ReadonlyMap<string, ItemAccount>,
): BookInvoiceRow[] {
  const list = answer.QueryResponse?.Invoice;
  if (!Array.isArray(list)) return [];
  return (list as QboInvoice[])
    .map((record) => parseInvoice(record, items))
    .filter((row): row is BookInvoiceRow => row !== null);
}

/** How many records of a kind an answer held, to know whether to ask for another page. */
export const answerCount = (kind: string, answer: QueryAnswer) => {
  const list = answer.QueryResponse?.[kind];
  return Array.isArray(list) ? list.length : 0;
};
