/**
 * The list as a spreadsheet: one row per conversation, the columns the
 * owner's help desk exports. No message text. Pure.
 */

export type ExportRow = {
  number: number;
  subject: string;
  customer_name: string | null;
  customer_email: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  tags: string[];
  messages: number;
  created_at: string;
  last_message_at: string;
  first_reply_at: string | null;
  closed_at: string | null;
  kind: string | null;
  mood: string | null;
};

export const EXPORT_COLUMNS = [
  "number",
  "subject",
  "customer_name",
  "customer_email",
  "status",
  "priority",
  "assignee",
  "tags",
  "messages",
  "created_at",
  "last_message_at",
  "first_reply_at",
  "closed_at",
  "kind",
  "mood",
] as const;

/**
 * One cell. Quoted when it holds a comma, quote or line break; and a cell a
 * spreadsheet would run as a formula (it starts with = + - or @, which a
 * customer's subject line can) is given a leading apostrophe so it stays text.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ticketsCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      EXPORT_COLUMNS.map((column) =>
        csvCell(column === "tags" ? row.tags.join("; ") : row[column]),
      ).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export const exportName = (day: string) => `conversations-${day}.csv`;
