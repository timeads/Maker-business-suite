import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadDebtView } from "@/lib/dashboard/debt/data";
import { changeWords, whatIfChangesSchema, whatIfFigures } from "@/lib/dashboard/debt/what-if";
import { formatMoney } from "@/lib/dashboard/format";
import { periodLabel } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { RemoveWhatIf } from "../../debt-forms";
import { WhatIfBox } from "./what-if-box";

export const metadata: Metadata = { title: "What if…" };

const monthWords = (month: string | null) =>
  month ? periodLabel(`${month}-01`, "month", true) : "not within the plan";

/**
 * Money → What if…: try a change to the debts or the plan and see the
 * engine's figures beside the plan as it is. Owners and admins only.
 * Saved what-ifs are worked out again from today's figures on each visit.
 */
export default async function WhatIfPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/debts/what-if`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const view = await loadDebtView(supabase, tenant);
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const names = new Map(view.debts.map((d) => [d.id, d.name]));
  const known = new Set(view.debts.map((d) => d.id));

  return (
    <>
      <PageHeader
        title="What if…"
        description="Try a change to your debts or your plan and see how it plays out, without changing anything."
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/dashboard/debts`}>Payoff plan</Link>
        </Button>
      </PageHeader>

      {view.input.debts.every((d) => !d.active || d.balance <= 0) ? (
        <Card>
          <CardHeader>
            <CardTitle>Add your debts first</CardTitle>
            <CardDescription>
              What-ifs work from the debts and balances you&apos;ve given.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href={`${base}/dashboard/debts/accounts`}>Add your debts</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <WhatIfBox
              slug={tenant.slug}
              currency={tenant.currency}
              canKeep={entitlements.canWrite}
            />
          </CardContent>
        </Card>
      )}

      {view.whatIfs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What-ifs you kept</CardTitle>
            <CardDescription>Worked out again from today&apos;s figures.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3 text-sm">
              {view.whatIfs.map((w) => {
                const changes = whatIfChangesSchema.safeParse(w.changes);
                const usable = changes.success && changes.data.debts.every((d) => known.has(d.id));
                const now = usable ? whatIfFigures(view.input, changes.data) : null;
                return (
                  <li
                    key={w.id}
                    className="border-border flex flex-col gap-1 rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-read">“{w.question}”</span>
                      <span className="text-muted-foreground text-xs">
                        kept {periodLabel(w.savedAt.slice(0, 10), "day", true)}
                      </span>
                    </div>
                    {usable && now ? (
                      <>
                        <span className="text-muted-foreground">
                          {changeWords(changes.data, names, money).join(" · ")}
                        </span>
                        <span>
                          Debt-free{" "}
                          {now.whatIf.months === null
                            ? "not within 50 years"
                            : `by ${monthWords(now.whatIf.payoffMonth)}`}{" "}
                          (plan now:{" "}
                          {now.now.months === null
                            ? "not within 50 years"
                            : monthWords(now.now.payoffMonth)}
                          ), interest {money(now.whatIf.interest)} against {money(now.now.interest)}
                          .
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        A debt in this one has since been removed, so it can&apos;t be worked out
                        again.
                      </span>
                    )}
                    {entitlements.canWrite && <RemoveWhatIf slug={tenant.slug} id={w.id} />}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
