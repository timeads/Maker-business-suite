import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { csvCell } from "@/lib/bookings/emails";
import { localDay } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

/** The list of who's coming to one date, as a spreadsheet file. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const user = await requireUser(`/w/${slug}/bookings/sessions/${id}`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx || !/^[0-9a-f-]{36}$/i.test(id)) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return missing;

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("sessions")
    .select("starts_at, services(name)")
    .eq("id", id)
    .eq("tenant_id", ctx.tenant.id)
    .maybeSingle();
  if (!session) return missing;
  const { data: rows } = await supabase
    .from("bookings")
    .select("customer_name, customer_email, seats, amount_cents, attendance, notes, tags, answers")
    .eq("session_id", id)
    .eq("status", "confirmed")
    .order("created_at");
  const bookings = (rows ?? []) as {
    customer_name: string;
    customer_email: string;
    seats: number;
    amount_cents: number;
    attendance: string | null;
    notes: string;
    tags: string[];
    answers: Record<string, string>;
  }[];
  const questions = [...new Set(bookings.flatMap((b) => Object.keys(b.answers ?? {})))];
  const lines = [
    ["Name", "Email", "Places", "Paid", "Checked in", "Tags", "Notes", ...questions],
    ...bookings.map((b) => [
      b.customer_name,
      b.customer_email,
      b.seats,
      (b.amount_cents / 100).toFixed(2),
      b.attendance === "attended" ? "Yes" : b.attendance === "no_show" ? "No-show" : "",
      (b.tags ?? []).join(", "),
      b.notes,
      ...questions.map((q) => b.answers?.[q] ?? ""),
    ]),
  ];
  const name = (session.services as unknown as { name: string }).name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const day = localDay(new Date(session.starts_at as string), ctx.tenant.timezone);
  return new NextResponse(lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name || "bookings"}-${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
