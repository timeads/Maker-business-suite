import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  EXPENSES_KEY,
  EXPENSES_MODULE,
  RULE_WORDS,
  actionWords,
  parseExpenseSorting,
} from "@/lib/dashboard/expenses";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { ExpenseSortingForm } from "../../../dashboard/money-settings-forms";

export const metadata: Metadata = { title: "Sorting expenses" };

/** How many recent expenses the payee and account suggestions are drawn from. */
const SEEN = 1000;

/** The most common names, most used first. */
function commonest(values: (string | null)[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value && value.trim()) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

/**
 * Settings → Money → Sorting expenses: payee defaults and rules that sort
 * the books' expenses into lines (or only suggest). The whole team can look;
 * owners and admins change it.
 */
export default async function ExpenseSortingSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/expenses`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [revenue, config, seen] = await Promise.all([
    loadRevenueSettings(supabase, tenant.id),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", EXPENSES_MODULE)
      .eq("key", EXPENSES_KEY)
      .maybeSingle(),
    supabase
      .from("book_expenses")
      .select("payee, account")
      .eq("tenant_id", tenant.id)
      .eq("is_move", false)
      .is("removed_at", null)
      .order("txn_date", { ascending: false })
      .limit(SEEN),
  ]);
  const settings = parseExpenseSorting(config.data?.body);
  const rows = (seen.data ?? []) as { payee: string | null; account: string | null }[];
  const lineName = (id: string) =>
    revenue.lines.find((line) => line.id === id)?.name ?? "a removed line";

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard/expenses`, label: "Expenses to sort" }}
        title="Sorting expenses"
        description="Tell Money where the usual expenses go, so the inbox mostly sorts itself. Your own choice on an expense always wins."
      />
      <Card>
        <CardHeader>
          <CardTitle>Payee defaults and rules</CardTitle>
          <CardDescription>
            New expenses from your books are checked against these as they arrive. One that a rule
            only suggests waits in the inbox with the suggestion beside it. Nothing here ever
            changes an expense someone sorted by hand, or one put back in the inbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {revenue.lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Set up your business lines first.{" "}
              <Link href={`${base}/settings/money/lines`} className="underline underline-offset-4">
                Revenue and business lines
              </Link>
            </p>
          ) : canEdit ? (
            <ExpenseSortingForm
              slug={tenant.slug}
              settings={settings}
              lines={revenue.lines}
              payees={commonest(
                rows.map((row) => row.payee),
                200,
              )}
              accounts={commonest(
                rows.map((row) => row.account),
                200,
              )}
            />
          ) : settings.vendors.length === 0 && settings.rules.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No payee defaults or rules yet. An owner or admin can add them here.
            </p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <ul className="flex flex-col gap-1">
                {settings.vendors.map((v) => (
                  <li key={v.id}>
                    Everything from {v.payee} → {actionWords(v.action, lineName)}
                    {v.fill_in ? "" : " (suggested only)"}
                  </li>
                ))}
              </ul>
              <ol className="list-decimal pl-5">
                {settings.rules.map((r) => (
                  <li key={r.id}>
                    {RULE_WORDS[r.field].label} “{r.words}” → {actionWords(r.action, lineName)}
                    {r.fill_in ? "" : " (suggested only)"}
                    {r.firm ? ", before payee defaults" : ""}
                  </li>
                ))}
              </ol>
              <p className="text-muted-foreground">An owner or admin can change these.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
