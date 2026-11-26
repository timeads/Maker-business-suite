import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeConfig, findConfig } from "@/lib/assistant/registry";
import { requireUser } from "@/lib/auth";
import { loadDebtSettings, sheetBanks } from "@/lib/dashboard/debt/data";
import { ORDER_CHOICE, orderOf } from "@/lib/dashboard/debt/settings";
import { bankKey, emergencyFund, pickedBanks } from "@/lib/dashboard/debt/figures";
import { formatMoney } from "@/lib/dashboard/format";
import { DEBT_FIELDS } from "@/lib/dashboard/figure-fields";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { DebtImportForm, EmergencyAccountPicker } from "../../../dashboard/debt-forms";
import { FigureSettingsForm } from "../../../dashboard/money-figure-forms";

export const metadata: Metadata = { title: "Debt payoff and emergency fund" };

/**
 * Settings → Money → Debt payoff and emergency fund. Owners and admins only:
 * for anyone else this page doesn't exist, and the database won't hand them
 * the setting either.
 */
export default async function DebtSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/debts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [settings, sheet] = await Promise.all([
    loadDebtSettings(supabase, tenant.id),
    supabase
      .from("financial_snapshots")
      .select("data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "balance_sheet")
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const banks = sheetBanks((sheet.data as { data?: Record<string, unknown> } | null)?.data) ?? [];
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const picked = pickedBanks(settings, banks);
  const unread = emergencyFund(settings, [], banks).missing;
  const entry = findConfig("dashboard", "debt")!;

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard/debts`, label: "Payoff plan" }}
        title="Debt payoff and emergency fund"
        description="How your payoff plan sends extra money, and how your emergency fund is built up alongside it. Only owners and admins see any of this."
      />
      <Card>
        <CardHeader>
          <CardTitle>The plan</CardTitle>
          <CardDescription>
            The debts themselves come from your QuickBooks balance sheet, and you add their rates
            and payments on{" "}
            <Link
              href={`${base}/dashboard/debts/accounts`}
              className="underline underline-offset-4"
            >
              Debts
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {entitlements.canWrite ? (
            <FigureSettingsForm
              slug={tenant.slug}
              setting="debt"
              groups={DEBT_FIELDS}
              body={{ ...settings, [ORDER_CHOICE]: orderOf(settings) }}
              currency={tenant.currency}
            />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {describeConfig(entry, settings).map((line) => (
                <li key={line}>{line}.</li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card id="emergency-accounts">
        <CardHeader>
          <CardTitle>The emergency fund&apos;s accounts</CardTitle>
          <CardDescription>
            Tick the bank accounts the fund is kept in. Its balance is read from your books each
            time they sync, so it&apos;s always up to date.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {banks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No bank accounts on a balance sheet yet. Once QuickBooks has synced, they show up here
              to tick.
            </p>
          ) : entitlements.canWrite ? (
            <EmergencyAccountPicker
              slug={tenant.slug}
              banks={banks.map((bank) => ({
                key: bankKey(bank),
                id: bank.id ?? null,
                name: bank.name,
                balance: money(bank.cents),
              }))}
              picked={picked.map(bankKey)}
            />
          ) : (
            <p className="text-sm">
              {picked.length > 0
                ? `Kept in ${picked.map((bank) => bank.name).join(", ")}.`
                : "No account chosen yet."}
            </p>
          )}
          {unread.length > 0 && (
            <p className="text-ochre-text text-sm">
              Your latest balance sheet doesn&apos;t have {unread.join(", ")}. Tick the account the
              fund is in now.
            </p>
          )}
        </CardContent>
      </Card>
      <Card id="bring-across">
        <CardHeader>
          <CardTitle>Bring your debt details across</CardTitle>
          <CardDescription>
            Moving from another app? Save its list of debts as a CSV with a column for each
            debt&apos;s name or account, and any of: rate %, minimum, usual payment, plan, priority,
            due day and note. Each row is matched to a debt from your books by its account name.
            Only details you haven&apos;t set are filled in, and you see everything before it
            happens. Paid several debts through one plan? Add a &ldquo;consolidated&rdquo; column
            (yes on the plan&apos;s row) and a &ldquo;paid through&rdquo; column naming the plan on
            each debt it pays.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entitlements.canWrite ? (
            <DebtImportForm slug={tenant.slug} />
          ) : (
            <p className="text-muted-foreground text-sm">
              Your plan doesn&apos;t include changing Money right now.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
