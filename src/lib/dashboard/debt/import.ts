import { parseCsv } from "../../stock/import/csv";
import { toCents } from "../lines";
import { PLAN_KIND_WORDS, bpWords, percentToBp } from "./settings";

/**
 * "Bring your debt details across": a spreadsheet of what an earlier app
 * knew about each debt (its rate, minimum, usual payment, how the plan pays
 * it, its place, due day and a note), matched to the debts that came from
 * the books and filling ONLY what a person hasn't set. Pure: read in the
 * browser, worked out here for the preview, and written by one checked
 * function (`import_money_debt_details`) that re-checks every field under
 * the debt's row lock. Columns: docs/money-import.md.
 */

export const IMPORT_MAX_ROWS = 200;

/** Each field's column, and the other headings it is known by (capitals and spacing don't matter). */
export const DEBT_IMPORT_COLUMNS = {
  name: ["name", "account", "account_name", "debt", "debt_name"],
  rate: ["rate", "rate_pct", "rate_percent", "apr", "interest_rate", "interest"],
  minimum: ["minimum", "minimum_payment", "min_payment", "minimum_cents"],
  payment: ["usual_payment", "payment", "monthly_payment"],
  plan: ["plan", "plan_kind", "paid_by"],
  priority: ["priority", "place", "order"],
  due_day: ["due_day", "due", "due_date"],
  note: ["note", "notes"],
} as const;
export type ImportField = Exclude<keyof typeof DEBT_IMPORT_COLUMNS, "name">;
export const IMPORT_FIELDS: readonly ImportField[] = [
  "rate",
  "minimum",
  "payment",
  "plan",
  "priority",
  "due_day",
  "note",
];

export const IMPORT_FIELD_WORDS: Record<ImportField, string> = {
  rate: "rate",
  minimum: "minimum",
  payment: "usual payment",
  plan: "how it's paid",
  priority: "place in your order",
  due_day: "due day",
  note: "note",
};

const PLAN_WORDS: Record<string, "pool" | "fixed" | "revenue_share"> = {
  pool: "pool",
  snowball: "pool",
  plan: "pool",
  paid_down_by_the_plan: "pool",
  fixed: "fixed",
  fixed_payment: "fixed",
  committed: "fixed",
  revenue_share: "revenue_share",
  share_of_sales: "revenue_share",
  revenue: "revenue_share",
  sales: "revenue_share",
};

export type DebtDetails = {
  rate_bp?: number;
  minimum_cents?: number;
  payment_cents?: number;
  plan?: "pool" | "fixed" | "revenue_share";
  priority?: number;
  due_day?: number;
  note?: string;
};

export type ImportRow = { line: number; name: string; details: DebtDetails };

export type ReadDebtFile =
  | { ok: true; rows: ImportRow[]; problems: { line: number; text: string }[] }
  | { ok: false; error: string };

const MAX_CENTS = 100_000_000_000;

/** Money as a spreadsheet writes it ("$1,250.00", "1250"); null when it isn't money. */
function moneyCents(raw: string): number | null {
  const clean = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = toCents(clean);
  return cents <= MAX_CENTS ? cents : null;
}

const wholeIn = (raw: string, min: number, max: number) => {
  if (!/^\d{1,4}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : null;
};

/** The file read: one row per debt, and the lines it couldn't use, in words. */
export function readDebtFile(text: string): ReadDebtFile {
  const file = parseCsv(text);
  if (!file.ok) return file;
  const column = (field: keyof typeof DEBT_IMPORT_COLUMNS) =>
    (DEBT_IMPORT_COLUMNS[field] as readonly string[]).find((name) => file.headers.includes(name));
  const nameColumn = column("name");
  if (!nameColumn) {
    return {
      ok: false,
      error: "The file needs a column naming each debt: name or account, as your books have it.",
    };
  }
  if (file.rows.length > IMPORT_MAX_ROWS) {
    return { ok: false, error: `That's more than ${IMPORT_MAX_ROWS} rows. Split it in two.` };
  }
  const columns = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, column(f)])) as Record<
    ImportField,
    string | undefined
  >;
  const rows: ImportRow[] = [];
  const problems: { line: number; text: string }[] = [];
  for (const row of file.rows) {
    const cell = (field: ImportField) => {
      const key = columns[field];
      return key ? (row.cells[key] ?? "").trim() : "";
    };
    const name = (row.cells[nameColumn] ?? "").trim().replace(/\s+/g, " ");
    if (!name) {
      if (Object.values(row.cells).some((v) => v.trim() !== "")) {
        problems.push({ line: row.line, text: "has no name or account, so it's left out" });
      }
      continue;
    }
    const details: DebtDetails = {};
    const bad: string[] = [];
    const rate = cell("rate");
    if (rate) {
      const bp = percentToBp(rate);
      if (bp === null) bad.push("the rate");
      else details.rate_bp = bp;
    }
    for (const [field, key] of [
      ["minimum", "minimum_cents"],
      ["payment", "payment_cents"],
    ] as const) {
      const raw = cell(field);
      if (!raw) continue;
      const cents = moneyCents(raw);
      if (cents === null) bad.push(`the ${IMPORT_FIELD_WORDS[field]}`);
      else details[key] = cents;
    }
    const plan = cell("plan");
    if (plan) {
      const kind =
        PLAN_WORDS[
          plan
            .toLowerCase()
            .replace(/[^a-z]+/g, "_")
            .replace(/^_|_$/g, "")
        ];
      if (!kind) bad.push("how it's paid");
      else details.plan = kind;
    }
    const priority = cell("priority");
    if (priority) {
      const n = wholeIn(priority, 1, 999);
      if (n === null) bad.push("the place");
      else details.priority = n;
    }
    const due = cell("due_day");
    if (due) {
      const n = wholeIn(due.replace(/(st|nd|rd|th)$/i, ""), 1, 31);
      if (n === null) bad.push("the due day");
      else details.due_day = n;
    }
    const note = cell("note");
    if (note) details.note = note.slice(0, 500);
    if (bad.length > 0) {
      problems.push({
        line: row.line,
        text: `${name}: we couldn't read ${bad.join(", ")}, so ${bad.length === 1 ? "it's" : "those are"} left out`,
      });
    }
    rows.push({ line: row.line, name, details });
  }
  return { ok: true, rows, problems };
}

/** A debt as the import looks at it: its names and what is set already. */
export type ImportDebt = {
  id: string;
  name: string;
  booksAccount: string | null;
  rateBp: number | null;
  minimum: number;
  payment: number | null;
  plan: string;
  priority: number | null;
  dueDay: number | null;
  note: string | null;
  /** Someone has saved this debt by hand (so its plan is their word, even "pool"). */
  savedByPerson: boolean;
};

const folded = (name: string) => name.toLowerCase().replace(/\s+/g, "");

/**
 * The one debt a row means: by its account's or its own name exactly, then
 * ignoring capitals and spaces; never a guess between two.
 */
export function matchDebt(
  name: string,
  debts: readonly ImportDebt[],
): { debt: ImportDebt } | { none: true } | { several: true } {
  const names = (d: ImportDebt) => [d.booksAccount, d.name].filter((n): n is string => !!n);
  const exact = debts.filter((d) => names(d).some((n) => n.trim() === name));
  if (exact.length === 1) return { debt: exact[0] };
  if (exact.length > 1) return { several: true };
  const loose = debts.filter((d) => names(d).some((n) => folded(n) === folded(name)));
  if (loose.length === 1) return { debt: loose[0] };
  return loose.length > 1 ? { several: true } : { none: true };
}

/** Is this field still the person's to fill, on this debt? The database asks the same. */
export function fieldOpen(debt: ImportDebt, field: ImportField): boolean {
  switch (field) {
    case "rate":
      return debt.rateBp === null;
    case "minimum":
      return debt.minimum === 0;
    case "payment":
      return debt.payment === null;
    case "plan":
      return !debt.savedByPerson;
    case "priority":
      return debt.priority === null;
    case "due_day":
      return debt.dueDay === null;
    case "note":
      return debt.note === null;
  }
}

const DETAIL_OF: Record<ImportField, keyof DebtDetails> = {
  rate: "rate_bp",
  minimum: "minimum_cents",
  payment: "payment_cents",
  plan: "plan",
  priority: "priority",
  due_day: "due_day",
  note: "note",
};

export type ImportPlan = {
  /** What would be filled, per debt. */
  fills: {
    line: number;
    debtId: string;
    debtName: string;
    details: DebtDetails;
    kept: ImportField[];
  }[];
  /** Rows not used, in words. */
  skipped: { line: number; text: string }[];
};

/** What the import would do: only fields not set yet, one row per debt. */
export function planDebtImport(
  rows: readonly ImportRow[],
  debts: readonly ImportDebt[],
): ImportPlan {
  const fills: ImportPlan["fills"] = [];
  const skipped: ImportPlan["skipped"] = [];
  const used = new Set<string>();
  for (const row of rows) {
    const found = matchDebt(row.name, debts);
    if ("none" in found) {
      skipped.push({ line: row.line, text: `${row.name}: no debt from your books by that name` });
      continue;
    }
    if ("several" in found) {
      skipped.push({
        line: row.line,
        text: `${row.name}: more than one debt could be meant, so it's left for you`,
      });
      continue;
    }
    if (used.has(found.debt.id)) {
      skipped.push({ line: row.line, text: `${row.name}: already earlier in the file` });
      continue;
    }
    used.add(found.debt.id);
    const details: DebtDetails = {};
    const kept: ImportField[] = [];
    for (const field of IMPORT_FIELDS) {
      const key = DETAIL_OF[field];
      if (row.details[key] === undefined) continue;
      if (fieldOpen(found.debt, field)) {
        (details as Record<string, unknown>)[key] = row.details[key];
      } else kept.push(field);
    }
    if (Object.keys(details).length === 0) {
      skipped.push({
        line: row.line,
        text: `${found.debt.name}: everything in this row is set already`,
      });
      continue;
    }
    fills.push({ line: row.line, debtId: found.debt.id, debtName: found.debt.name, details, kept });
  }
  return { fills, skipped };
}

/** What a row fills, in words, for the preview. */
export function detailWords(details: DebtDetails, money: (cents: number) => string): string[] {
  const out: string[] = [];
  if (details.rate_bp !== undefined) out.push(`rate ${bpWords(details.rate_bp)}`);
  if (details.minimum_cents !== undefined) out.push(`minimum ${money(details.minimum_cents)}`);
  if (details.payment_cents !== undefined)
    out.push(`usual payment ${money(details.payment_cents)}`);
  if (details.plan !== undefined) out.push(PLAN_KIND_WORDS[details.plan].toLowerCase());
  if (details.priority !== undefined) out.push(`place ${details.priority}`);
  if (details.due_day !== undefined) out.push(`due on day ${details.due_day}`);
  if (details.note !== undefined) out.push(`note “${details.note}”`);
  return out;
}
