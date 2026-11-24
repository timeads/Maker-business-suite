import type { BookPaymentRow } from "../types";

/**
 * Money paid out to suppliers, as QuickBooks records it. Pure: the questions
 * to ask and how to read the answers. Two kinds of record are money leaving
 * the bank for a supplier: a bill payment, and a purchase (a cheque, a card
 * charge or cash) made out to a vendor. Bills, credits and estimates are not
 * payments and are never asked for. Read-only: nothing is written to the books.
 *
 * Stock's Balances tab files these on the matching supplier's account when
 * the workspace has asked for that (`import_book_payments`).
 */

export const PAYMENT_ENTITIES = ["BillPayment", "Purchase"] as const;
export type PaymentEntity = (typeof PAYMENT_ENTITIES)[number];

/** How many records one question asks for, and how many questions per kind. */
export const PAYMENT_PAGE = 500;
export const PAYMENT_PAGES = 6;

/** QuickBooks' query language: records of one kind dated on or after a day, a page at a time. */
export function paymentsQuery(entity: PaymentEntity, since: string, page: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("since must be a plain day");
  const start = Math.max(0, Math.trunc(page)) * PAYMENT_PAGE + 1;
  return `select * from ${entity} where TxnDate >= '${since}' orderby TxnDate startposition ${start} maxresults ${PAYMENT_PAGE}`;
}

type Ref = { value?: unknown; name?: unknown; type?: unknown } | null | undefined;
type QboRecord = {
  Id?: unknown;
  TxnDate?: unknown;
  TotalAmt?: unknown;
  PrivateNote?: unknown;
  VendorRef?: Ref;
  EntityRef?: Ref;
  /** On a card purchase: true means money came back (a refund). */
  Credit?: unknown;
};
export type PaymentsResponse = { QueryResponse?: Record<string, unknown> | null };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** The records of one kind in an answer, as rows for Stock. Anything unclear is left out. */
export function parsePayments(entity: PaymentEntity, response: PaymentsResponse): BookPaymentRow[] {
  const list = response.QueryResponse?.[entity];
  if (!Array.isArray(list)) return [];
  const rows: BookPaymentRow[] = [];
  for (const record of list as QboRecord[]) {
    if (!record || typeof record !== "object") continue;
    // A purchase names whoever was paid; only one made out to a vendor is a supplier payment.
    const payee =
      entity === "BillPayment"
        ? text(record.VendorRef?.name)
        : text(record.EntityRef?.type).toLowerCase() === "vendor"
          ? text(record.EntityRef?.name)
          : "";
    const id = text(record.Id);
    const date = text(record.TxnDate).slice(0, 10);
    const amount = Number(record.TotalAmt);
    if (!id || !payee || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (entity === "Purchase" && record.Credit === true) continue;
    rows.push({
      external_id: id,
      kind: entity,
      date,
      payee: payee.slice(0, 200),
      amount: Math.round(amount * 100) / 100,
      memo: text(record.PrivateNote).slice(0, 300),
    });
  }
  return rows;
}

/** How many records an answer held, to know whether to ask for another page. */
export const answerSize = (entity: PaymentEntity, response: PaymentsResponse) => {
  const list = response.QueryResponse?.[entity];
  return Array.isArray(list) ? list.length : 0;
};
