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

/**
 * Two optional columns for a plan that pays other debts (a consolidated
 * debt): a row that IS such a plan, and, on a debt's own row, the plan that
 * pays it.
 */
export const PLAN_IMPORT_COLUMNS = {
  consolidated: ["consolidated", "is_plan", "pays_other_debts", "debt_plan"],
  paid_through: ["paid_through", "covered_by", "consolidated_into", "paid_by_plan"],
} as const;

const YES = new Set(["yes", "y", "true", "1", "x"]);
const NO = new Set(["no", "n", "false", "0", ""]);
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

export type ImportRow = {
  line: number;
  name: string;
  details: DebtDetails;
  /** This row is a plan that pays other debts. */
  isPlan?: boolean;
  /** The plan that pays this row's debt, as the file names it. */
  paidThrough?: string | null;
};

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
  const planColumn = (field: keyof typeof PLAN_IMPORT_COLUMNS) =>
    (PLAN_IMPORT_COLUMNS[field] as readonly string[]).find((name) => file.headers.includes(name));
  const isPlanColumn = planColumn("consolidated");
  const throughColumn = planColumn("paid_through");
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
    const planCell = isPlanColumn ? (row.cells[isPlanColumn] ?? "").trim().toLowerCase() : "";
    const isPlan = YES.has(planCell);
    if (!isPlan && !NO.has(planCell)) bad.push("whether it's a plan");
    const paidThrough = throughColumn
      ? (row.cells[throughColumn] ?? "").trim().replace(/\s+/g, " ").slice(0, 80) || null
      : null;
    if (bad.length > 0) {
      problems.push({
        line: row.line,
        text: `${name}: we couldn't read ${bad.join(", ")}, so ${bad.length === 1 ? "it's" : "those are"} left out`,
      });
    }
    rows.push({
      line: row.line,
      name,
      details,
      ...(isPlan ? { isPlan } : {}),
      ...(paidThrough && !isPlan ? { paidThrough } : {}),
    });
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
  /** A plan that pays other debts. */
  consolidated?: boolean;
  /** Paid through a plan already. */
  coveredBy?: string | null;
};

/** One of the books' accounts, for linking a new plan to its own account by name. */
export type ImportAccount = { id: string; name: string };

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
  /** Plans that pay other debts, to be made (none of that name is here yet). */
  plans: {
    line: number;
    name: string;
    details: Pick<DebtDetails, "rate_bp" | "payment_cents" | "due_day" | "note">;
    /** Its own account in the books, found by its name (only ever one). */
    account: ImportAccount | null;
  }[];
  /** Debts to put under a plan (only ones no plan pays yet). */
  covers: { line: number; debtId: string; debtName: string; planName: string }[];
  /** Rows not used, in words. */
  skipped: { line: number; text: string }[];
};

/** The one account a name means, exactly then ignoring capitals and spaces; never a guess. */
function matchAccount(name: string, accounts: readonly ImportAccount[]): ImportAccount | null {
  const exact = accounts.filter((a) => a.name.trim() === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const loose = accounts.filter((a) => folded(a.name) === folded(name));
  return loose.length === 1 ? loose[0] : null;
}

/**
 * What the import would do: only fields not set yet, one row per debt; a
 * plan row naming no debt here becomes a new plan, and a "paid through"
 * puts a debt under a plan only when no plan pays it yet.
 */
export function planDebtImport(
  rows: readonly ImportRow[],
  debts: readonly ImportDebt[],
  accounts: readonly ImportAccount[] = [],
): ImportPlan {
  const fills: ImportPlan["fills"] = [];
  const plans: ImportPlan["plans"] = [];
  const covers: ImportPlan["covers"] = [];
  const skipped: ImportPlan["skipped"] = [];
  const used = new Set<string>();
  const planNames = new Map(
    debts.filter((d) => d.consolidated).map((d) => [folded(d.name), d.name] as const),
  );
  // Plans first, so a debt's row may name a plan that comes later in the file.
  const making = new Set<number>();
  for (const row of rows) {
    if (!row.isPlan) continue;
    const found = matchDebt(row.name, debts);
    if ("debt" in found && !found.debt.consolidated) {
      skipped.push({
        line: row.line,
        text: `${row.name}: is a debt by itself here, so it isn't made a plan. Make the plan on Money → Debts and tick what it pays`,
      });
      making.add(row.line);
      continue;
    }
    if (!("none" in found)) continue;
    making.add(row.line);
    if (planNames.has(folded(row.name))) {
      skipped.push({ line: row.line, text: `${row.name}: already earlier in the file` });
      continue;
    }
    planNames.set(folded(row.name), row.name);
    const { rate_bp, minimum_cents, payment_cents, due_day, note } = row.details;
    const payment = payment_cents ?? minimum_cents;
    plans.push({
      line: row.line,
      name: row.name,
      details: {
        ...(rate_bp !== undefined ? { rate_bp } : {}),
        ...(payment !== undefined ? { payment_cents: payment } : {}),
        ...(due_day !== undefined ? { due_day } : {}),
        ...(note !== undefined ? { note } : {}),
      },
      account: matchAccount(row.name, accounts),
    });
  }

  for (const row of rows) {
    if (making.has(row.line)) continue;
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
    // Said something about this row already (so "everything is set" isn't said too).
    let noted = false;
    if (row.paidThrough) {
      const planName = planNames.get(folded(row.paidThrough));
      if (!planName) {
        skipped.push({
          line: row.line,
          text: `${found.debt.name}: no plan called “${row.paidThrough}” here or in the file, so it isn't put under one`,
        });
      } else if (found.debt.consolidated) {
        skipped.push({ line: row.line, text: `${found.debt.name}: a plan can't pay another plan` });
      } else if (found.debt.coveredBy) {
        skipped.push({
          line: row.line,
          text: `${found.debt.name}: already paid through a plan, so it stays where it is`,
        });
      } else {
        covers.push({ line: row.line, debtId: found.debt.id, debtName: found.debt.name, planName });
      }
      noted = true;
    }
    const details: DebtDetails = {};
    const kept: ImportField[] = [];
    for (const field of IMPORT_FIELDS) {
      const key = DETAIL_OF[field];
      if (row.details[key] === undefined) continue;
      // A plan is always one fixed payment: how it's paid and a minimum aren't its.
      if (found.debt.consolidated && (field === "plan" || field === "minimum")) continue;
      if (fieldOpen(found.debt, field)) {
        (details as Record<string, unknown>)[key] = row.details[key];
      } else kept.push(field);
    }
    if (Object.keys(details).length === 0) {
      if (!noted) {
        skipped.push({
          line: row.line,
          text: `${found.debt.name}: everything in this row is set already`,
        });
      }
      continue;
    }
    fills.push({ line: row.line, debtId: found.debt.id, debtName: found.debt.name, details, kept });
  }
  return { fills, plans, covers, skipped };
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
