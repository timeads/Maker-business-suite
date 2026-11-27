import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { liabilityExplained } from "@/lib/dashboard/explain";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadBooksState, loadDebtView } from "@/lib/dashboard/debt/data";
import { isPaidOff, paymentWords, type Debt } from "@/lib/dashboard/debt/figures";
import { coverWords } from "@/lib/dashboard/debt/plans";
import { noPlaceWords, withPlaces } from "@/lib/dashboard/debt/order";
import { STRATEGY_META } from "@/lib/dashboard/debt/engine";
import {
  DEBT_KIND_WORDS,
  DEBT_STATUS_WORDS,
  PLAN_KIND_WORDS,
  bpWords,
  type DebtKind,
} from "@/lib/dashboard/debt/settings";
import { formatMoney } from "@/lib/dashboard/format";
import { localDate, periodLabel } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import {
  BalanceForm,
  BookChoiceButton,
  DebtForm,
  DebtPlanForm,
  HideLiabilityButton,
  ReadBooksButton,
  RowButton,
  UncoverButton,
  type DebtFormValues,
  type DebtPlanFormValues,
  type PlanCandidate,
} from "../../debt-forms";
import { DebtOrder } from "../../debt-order";

export const metadata: Metadata = { title: "Debts" };

const STATUS_TONE: Record<Debt["status"], BadgeTone> = {
  active: "open",
  paused: "waiting",
  closed: "closed",
};

const amountText = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
const percentText = (bp: number | null) => (bp === null ? "" : bpWords(bp).replace(/%$/, ""));

const formValues = (d: Debt | null): DebtFormValues => ({
  id: d?.id ?? null,
  name: d?.name ?? "",
  kind: d?.kind ?? "card",
  plan: d?.plan ?? "pool",
  status: d?.status ?? "active",
  rate: d && !d.needsRate ? percentText(d.rateBp) : "",
  minimum: d ? amountText(d.minimum) : "",
  payment: amountText(d?.payment ?? null),
  revolving: percentText(d?.revolvingBp ?? null),
  due_day: d?.dueDay ? String(d.dueDay) : "",
  priority: d?.priority ? String(d.priority) : "",
  opening: amountText(d?.opening ?? null),
  books_account: d?.booksAccount ?? "",
  note: d?.note ?? "",
  balance: "",
});

const planValues = (
  d: Debt | null,
  start: Partial<DebtPlanFormValues> = {},
): DebtPlanFormValues => ({
  id: d?.id ?? null,
  name: d?.name ?? "",
  status: d?.status ?? "active",
  rate: d && !d.needsRate ? percentText(d.rateBp) : "",
  payment: amountText(d?.payment ?? null),
  due_day: d?.dueDay ? String(d.dueDay) : "",
  priority: d?.priority ? String(d.priority) : "",
  // Only what was typed: blank adds up what its debts started at.
  opening: amountText(d?.group?.ownOpening ?? null),
  note: d?.note ?? "",
  balance_from: d?.planBalanceFrom ?? "covered",
  plan_account_id: d?.planAccountId ?? "",
  covers: d?.group?.covers.map((c) => c.id) ?? [],
  ...start,
});

/**
 * Money → Debts: each card, loan and line of credit, made from the books'
 * balance sheet each time QuickBooks syncs (or typed in, for one that isn't
 * in the books), with its balances and the payments the books show into it;
 * and the books' other liabilities, which an owner or admin can count as a
 * debt. Owners and admins only.
 */
export default async function DebtsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/debts/accounts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [view, history, moves] = await Promise.all([
    loadDebtView(supabase, tenant),
    supabase
      .from("money_debt_balances")
      .select("id, debt_id, as_of, balance_cents, source")
      .eq("tenant_id", tenant.id)
      .order("as_of", { ascending: false })
      .order("noted_at", { ascending: false })
      .limit(600),
    supabase.rpc("money_move_accounts", { p_tenant_id: tenant.id }),
  ]);
  if (history.error) throw new Error(`Could not load the balances: ${history.error.message}`);
  const balances = (history.data ?? []) as {
    id: string;
    debt_id: string;
    as_of: string;
    balance_cents: number;
    source: "person" | "books";
  }[];
  const accounts = [
    ...new Set(((moves.data ?? []) as { account: string }[]).map((row) => row.account)),
  ];
  const books = await loadBooksState(supabase, tenant.id, view.debts);
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const when = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  const readWords = books.lastRead
    ? `Last read from QuickBooks on ${when(books.lastRead)}.`
    : "Not read from QuickBooks yet.";
  const day = (iso: string) => periodLabel(iso, "day", true);
  const local = localDate(new Date(), tenant.timezone);
  const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const pays = (d: Debt) =>
    paymentWords(d, {
      revenueSharePct: view.settings.revenue_share_pct,
      averageRevenue: view.input.averageRevenue,
      money,
    });

  // On the page: what's owed (plans whole), then the debts at nothing owed
  // the books still list, folded away. Covered debts sit under their plan.
  // Debts with a place in "your own order" first, in it; then the rest.
  const placed = withPlaces(view.debts.filter((d) => !isPaidOff(d)));
  const active = placed.map((p) => p.debt);
  const placeOf = new Map(placed.map((p) => [p.debt.id, p.place]));
  const ordered = placed.filter((p) => p.place !== null).map((p) => p.debt);
  const ownOrderOn = view.strategyFrom === "person" && view.strategy === "custom";
  const paidOff = view.debts.filter(isPaidOff);
  const plans = view.debts.filter((d) => d.consolidated);
  const covered = plans.flatMap((p) => p.group?.covers ?? []);
  const planOf = new Map(
    plans.flatMap((p) => [
      ...(p.group?.covers ?? []).map((c) => [c.id, p] as const),
      ...(p.group?.accountDebt ? [[p.group.accountDebt.id, p] as const] : []),
    ]),
  );
  const accountDebts = plans.flatMap((p) => (p.group?.accountDebt ? [p.group.accountDebt] : []));
  const cards = [...active, ...covered, ...accountDebts, ...paidOff];
  const owedWords = (d: Debt) =>
    d.credit > 0
      ? `In credit, ${money(d.credit)}`
      : d.balance === null
        ? "No balance yet"
        : money(d.balance);
  // Every debt a plan could pay: not a plan, not a plan's own account.
  const coverable = [...view.debts.filter((d) => !d.consolidated), ...covered];
  const candidatesFor = (planId: string | null): PlanCandidate[] =>
    coverable.map((d) => ({
      id: d.id,
      name: d.name,
      detail: d.source === "books" ? `From your books: ${owedWords(d)}` : owedWords(d),
      takenBy:
        d.coveredBy && d.coveredBy !== planId
          ? (plans.find((p) => p.id === d.coveredBy)?.name ?? "another plan")
          : null,
    }));
  const accountsFor = (planId: string | null) =>
    books.accounts
      .filter((a) => !plans.some((p) => p.planAccountId === a.id && p.id !== planId))
      .map((a) => ({
        id: a.id,
        name: a.name,
        balance: a.balance < 0 ? `in credit, ${money(-a.balance)}` : money(a.balance),
      }));
  const planBalanceWords = (d: Debt) =>
    d.group?.balanceFrom === "covered"
      ? "The debts it pays, added up"
      : d.group?.balanceFrom === "account"
        ? d.group.account
          ? `From “${d.group.account.name}” in your books`
          : "Its account isn't in your books any more"
        : d.balanceAsOf
          ? `You gave it, ${day(d.balanceAsOf)}`
          : "Type in its balance below";

  return (
    <>
      <PageHeader
        title="Debts"
        description="Each card, loan and line of credit you're paying down, straight from your books. Only owners and admins can see these."
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/dashboard/debts`}>Payoff plan</Link>
        </Button>
      </PageHeader>

      {view.debts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Your debts come from your books</CardTitle>
            <CardDescription>
              Each time QuickBooks syncs, the cards, loans and lines of credit on your balance sheet
              show up here with what&apos;s owed on them. You add the rate and the usual payment,
              which QuickBooks doesn&apos;t keep. {readWords}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {books.connected ? (
              canEdit && <ReadBooksButton slug={tenant.slug} />
            ) : (
              <Button asChild variant="outline" size="sm" className="w-fit">
                <Link href={`${base}/connections`}>Connect QuickBooks</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 text-sm">
          <p>Balances come from your QuickBooks balance sheet. {readWords}</p>
          {books.connected && canEdit && <ReadBooksButton slug={tenant.slug} />}
        </div>
      )}

      {view.debts.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            {active.length === 0 ? (
              <p className="text-sm">Nothing owed on any of your debts right now. Well done.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-left text-sm">
                  <caption className="sr-only">Your debts</caption>
                  <thead className="text-muted-foreground text-xs">
                    <tr className="border-border border-b">
                      {[
                        "Place",
                        "Debt",
                        "How it's paid",
                        "Owed",
                        "Started at",
                        "Rate",
                        "A month",
                        "Status",
                        "Paid off",
                      ].map((h, i) => (
                        <th
                          key={h}
                          scope="col"
                          className={`py-2 font-medium ${i >= 3 && i <= 6 ? "px-2 text-right" : "px-2"}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((d) => {
                      const payoff = view.payoffs.get(d.id);
                      const group = d.group;
                      return [
                        <tr
                          key={d.id}
                          className={`border-border ${group ? "" : "border-b last:border-0"}`}
                        >
                          <td
                            className="px-2 py-2 tabular-nums"
                            title={noPlaceWords(d) ?? undefined}
                          >
                            {placeOf.get(d.id) ?? "–"}
                          </td>
                          <th scope="row" className="px-2 py-2 font-normal">
                            <a href={`#debt-${d.id}`} className="font-medium hover:underline">
                              {d.name}
                            </a>
                            <span className="text-muted-foreground block text-xs">
                              {group
                                ? coverWords(group, money)
                                : (DEBT_KIND_WORDS[d.kind as DebtKind] ?? d.kind)}
                              {d.dueDay ? ` · due on the ${d.dueDay}` : ""}
                            </span>
                          </th>
                          <td className="px-2 py-2">
                            {group ? "One payment for several debts" : PLAN_KIND_WORDS[d.plan]}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {d.balance === null ? "Not given" : money(d.balance)}
                            {group ? (
                              <span className="text-muted-foreground block text-xs">
                                {planBalanceWords(d)}
                              </span>
                            ) : (
                              d.balanceAsOf && (
                                <span className="text-muted-foreground block text-xs">
                                  {d.balanceFrom === "books" ? "From your books" : "You gave it"},{" "}
                                  {day(d.balanceAsOf)}
                                </span>
                              )
                            )}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {d.opening === null ? "–" : money(d.opening)}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {d.needsRate ? (
                              <Badge tone="waiting">Needs a rate</Badge>
                            ) : (
                              bpWords(d.rateBp)
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">{pays(d)}</td>
                          <td className="px-2 py-2">
                            <Badge tone={STATUS_TONE[d.status]}>
                              {DEBT_STATUS_WORDS[d.status]}
                            </Badge>
                          </td>
                          <td className="px-2 py-2">
                            {d.status !== "active"
                              ? "–"
                              : payoff
                                ? periodLabel(`${payoff}-01`, "month", true)
                                : (d.balance ?? 0) > 0
                                  ? "Beyond five years"
                                  : "Paid off"}
                          </td>
                        </tr>,
                        group && (
                          <tr
                            key={`${d.id}-covers`}
                            className="border-border border-b last:border-0"
                          >
                            <td />
                            <td colSpan={8} className="px-2 pb-3">
                              <details>
                                <summary className="text-muted-foreground cursor-pointer text-xs">
                                  What it pays ({group.covers.length})
                                </summary>
                                <ul className="mt-2 flex flex-col gap-1 text-sm">
                                  {group.covers.map((c) => (
                                    <li
                                      key={c.id}
                                      className="flex flex-wrap items-baseline justify-between gap-2"
                                    >
                                      <a href={`#debt-${c.id}`} className="hover:underline">
                                        {c.name}
                                      </a>
                                      <span className="text-muted-foreground tabular-nums">
                                        {c.status === "closed"
                                          ? "Gone from your books"
                                          : `${c.source === "books" ? "In your books: " : ""}${owedWords(c)}`}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                <p className="text-muted-foreground mt-2 text-xs">
                                  These aren&apos;t counted on their own while the plan pays them.
                                  What you filled in on each is kept, just as it was.
                                </p>
                              </details>
                              {group.differs && d.balance !== null && (
                                <p className="text-muted-foreground mt-1 text-xs" role="note">
                                  The plan&apos;s balance is {money(d.balance)}; the debts it pays
                                  add up to {money(group.coveredSum)} in your books.
                                </p>
                              )}
                              {group.gone.length > 0 && (
                                <p className="text-muted-foreground mt-1 text-xs" role="note">
                                  {group.gone.map((g) => g.name).join(", ")}{" "}
                                  {group.gone.length === 1 ? "has" : "have"} left your books, so{" "}
                                  {group.gone.length === 1 ? "it's" : "they're"} no longer in the
                                  sum.
                                </p>
                              )}
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {paidOff.length > 0 && (
              <details>
                <summary className="text-muted-foreground cursor-pointer text-sm">
                  Paid off ({paidOff.length})
                </summary>
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {paidOff.map((d) => (
                    <li
                      key={d.id}
                      className="border-border flex flex-wrap items-baseline justify-between gap-2 border-b pb-1 last:border-0"
                    >
                      <span>
                        <a href={`#debt-${d.id}`} className="font-medium hover:underline">
                          {d.name}
                        </a>
                        <span className="text-muted-foreground">
                          {" "}
                          · {DEBT_KIND_WORDS[d.kind as DebtKind] ?? d.kind}
                        </span>
                      </span>
                      <span className="tabular-nums">
                        {d.credit > 0 ? (
                          `In credit, ${money(d.credit)}`
                        ) : (
                          <Badge tone="good">Nothing owed</Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-2 text-xs">
                  Your books still list these with nothing owed. If one is used again, it comes back
                  up with the rest after the next sync.
                </p>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      {ordered.length > 1 && (
        <Card id="own-order" className="scroll-mt-4">
          <CardHeader>
            <CardTitle className="text-base">Your own order</CardTitle>
            <CardDescription>
              Which debt the extra goes to first when the plan follows your own order. Drag a debt,
              use its arrows or pick its number; the others shift to make room. Only debts paid down
              from the pool take a place: fixed payments, shares of sales, paused debts and plans
              that pay other debts keep their own pace.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DebtOrder
              slug={tenant.slug}
              canEdit={canEdit}
              following={
                ownOrderOn
                  ? null
                  : view.strategyFrom === "recommended"
                    ? `the recommended order (${STRATEGY_META[view.strategy].label.toLowerCase()})`
                    : `the ${STRATEGY_META[view.strategy].label.toLowerCase()} order you chose`
              }
              items={ordered.map((d) => ({
                id: d.id,
                name: d.name,
                detail: [
                  d.balance === null ? "No balance yet" : `${money(d.balance)} owed`,
                  d.needsRate ? "needs a rate" : `${bpWords(d.rateBp)} a year`,
                ].join(" · "),
              }))}
            />
          </CardContent>
        </Card>
      )}

      {(books.others.length > 0 || books.hidden.length > 0) && (
        <Card id="also-in-books" className="scroll-mt-4">
          <CardHeader>
            <CardTitle className="text-base">Also in your books</CardTitle>
            <CardDescription>
              Other things your balance sheet says you owe, like bills to suppliers or sales tax.
              They aren&apos;t counted as debts to pay down. If one is, count it and it joins the
              plan. If you pay one company that pays several of your debts for you, that&apos;s a
              plan: make it from its account here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {books.others.map((o) => (
                <li
                  key={o.id}
                  className="border-border flex flex-col gap-2 border-b pb-2 last:border-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="font-medium">{o.name}</span>
                      <span className="text-muted-foreground block text-xs">
                        {o.typeWords}
                        {o.markedNotDebt ? " · you said this isn't a debt" : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums">
                        {o.balance < 0 ? `In credit, ${money(-o.balance)}` : money(o.balance)}
                      </span>
                      {canEdit && (
                        <BookChoiceButton
                          slug={tenant.slug}
                          accountId={o.id}
                          choice="debt"
                          label="Count this as a debt"
                        />
                      )}
                      {canEdit && o.markedNotDebt && (
                        <BookChoiceButton
                          slug={tenant.slug}
                          accountId={o.id}
                          choice="rule"
                          label="Let my setting decide"
                          variant="ghost"
                        />
                      )}
                      {canEdit && (
                        <HideLiabilityButton
                          slug={tenant.slug}
                          accountId={o.id}
                          hidden={false}
                          name={o.name}
                        />
                      )}
                    </span>
                  </div>
                  <HowWorkedOut
                    label="Why isn't this a debt?"
                    lines={[
                      liabilityExplained({
                        typeWords: o.typeWords,
                        choice: o.markedNotDebt ? "not_debt" : null,
                        byRule: false,
                      }),
                    ]}
                    change={
                      o.markedNotDebt
                        ? null
                        : {
                            href: `${base}/settings/money/debts`,
                            label: "Change which kinds of account count by themselves",
                          }
                    }
                  />
                  {canEdit && (
                    <details>
                      <summary className="text-muted-foreground cursor-pointer text-xs">
                        This is a plan that pays other debts…
                      </summary>
                      <div className="mt-3">
                        <DebtPlanForm
                          slug={tenant.slug}
                          values={planValues(null, { name: o.name, plan_account_id: o.id })}
                          currency={tenant.currency}
                          candidates={candidatesFor(null)}
                          accounts={accountsFor(null)}
                        />
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
            {books.others.length === 0 && (
              <p className="text-muted-foreground text-sm">You&apos;ve hidden all of them.</p>
            )}
            {books.hidden.length > 0 && (
              <details className="mt-3">
                <summary className="text-muted-foreground cursor-pointer text-sm">
                  Hidden ({books.hidden.length})
                </summary>
                <ul className="mt-2 flex flex-col gap-2 text-sm">
                  {books.hidden.map((o) => (
                    <li
                      key={o.id}
                      className="border-border flex flex-wrap items-center justify-between gap-2 border-b pb-2 last:border-0"
                    >
                      <span>
                        <span className="font-medium">{o.name}</span>
                        <span className="text-muted-foreground block text-xs">{o.typeWords}</span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="tabular-nums">
                          {o.balance < 0 ? `In credit, ${money(-o.balance)}` : money(o.balance)}
                        </span>
                        {canEdit && (
                          <HideLiabilityButton
                            slug={tenant.slug}
                            accountId={o.id}
                            hidden
                            name={o.name}
                          />
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-2 text-xs">
                  Hiding only tidies this list. It never changes whether something counts as a debt.
                </p>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Card>
          <details>
            <summary className="cursor-pointer px-6 py-4 font-semibold">
              Add a debt that isn&apos;t in your books
            </summary>
            <CardContent>
              <DebtForm
                slug={tenant.slug}
                values={formValues(null)}
                currency={tenant.currency}
                accounts={accounts}
              />
            </CardContent>
          </details>
          <details className="border-border border-t">
            <summary className="cursor-pointer px-6 py-4 font-semibold">
              Add a plan that pays several debts
            </summary>
            <CardContent className="flex flex-col gap-3">
              <p className="text-muted-foreground text-sm">
                For when you pay one amount a month to a company that pays some of your cards or
                loans for you. The plan counts as one debt with its own payment; the debts it pays
                stay in your books and are folded under it.
              </p>
              <DebtPlanForm
                slug={tenant.slug}
                values={planValues(null)}
                currency={tenant.currency}
                candidates={candidatesFor(null)}
                accounts={accountsFor(null)}
              />
            </CardContent>
          </details>
        </Card>
      )}

      {cards.map((d) => {
        const mine = balances.filter((b) => b.debt_id === d.id).slice(0, 12);
        const paid = view.payments.filter((p) => p.debtId === d.id).slice(0, 8);
        const plan = planOf.get(d.id) ?? null;
        const isAccountOfPlan = plan?.group?.accountDebt?.id === d.id;
        const group = d.group;
        const paidOffNow = isPaidOff(d);
        return (
          <Card key={d.id} id={`debt-${d.id}`}>
            <CardHeader>
              <CardTitle className="text-base">{d.name}</CardTitle>
              <CardDescription>
                {group
                  ? `A plan that pays other debts: one payment of ${money(d.payment ?? 0)} a month, counted as one debt. ${coverWords(group, money)}.`
                  : d.source === "books"
                    ? `From “${d.booksAccount ?? d.name}” in your books: its balance and the payments into it come from there.`
                    : d.booksAccount
                      ? `Linked to “${d.booksAccount}” in your books: payments into it come from there.`
                      : "Not in your books: give its balance by hand."}
                {plan &&
                  (isAccountOfPlan
                    ? ` This is ${plan.name}'s own account, so it counts as part of the plan, not by itself.`
                    : ` Paid through ${plan.name}, so it isn't counted on its own while it is. Its own rate and minimum are kept for if that changes.`)}
                {d.credit > 0 &&
                  ` Your books show it in credit by ${money(d.credit)}: nothing owed.`}
                {d.needsRate &&
                  !plan &&
                  !paidOffNow &&
                  " It needs a rate: until it has one, the plan counts it at 0%."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-2">
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">Balances</h3>
                {group && group.balanceFrom !== "typed" ? (
                  <p className="text-sm">
                    {d.balance === null ? "No balance yet." : money(d.balance)}{" "}
                    <span className="text-muted-foreground">
                      {group.balanceFrom === "covered"
                        ? "· the debts it pays, added up from your books at every sync"
                        : group.account
                          ? `· from “${group.account.name}” in your books`
                          : "· its account isn't in your books any more"}
                    </span>
                  </p>
                ) : (
                  <>
                    {canEdit && d.source === "person" && (
                      <BalanceForm
                        slug={tenant.slug}
                        debtId={d.id}
                        name={d.name}
                        today={today}
                        currency={tenant.currency}
                      />
                    )}
                    {mine.length === 0 ? (
                      <p className="text-muted-foreground text-sm">No balance yet.</p>
                    ) : (
                      <ul className="flex flex-col gap-1 text-sm">
                        {mine.map((b) => (
                          <li
                            key={b.id}
                            className="flex flex-wrap items-center justify-between gap-2"
                          >
                            <span>
                              {day(b.as_of)}{" "}
                              <span className="text-muted-foreground">
                                {b.source === "books" ? "· from your books" : "· you gave it"}
                              </span>
                            </span>
                            <span className="flex items-center gap-1 tabular-nums">
                              {money(Number(b.balance_cents))}
                              {canEdit && b.source === "person" && (
                                <RowButton
                                  slug={tenant.slug}
                                  what="balance"
                                  id={b.id}
                                  label="Take back"
                                />
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                {group?.differs && d.balance !== null && (
                  <p className="text-muted-foreground text-xs" role="note">
                    The debts it pays add up to {money(group.coveredSum)} in your books.
                  </p>
                )}
                <h3 className="mt-2 text-sm font-semibold">Payments from your books</h3>
                {plan && !isAccountOfPlan ? (
                  <p className="text-muted-foreground text-sm">
                    {plan.planAccountId
                      ? `Payments show with ${plan.name}: the money moved into its own account.`
                      : `Payments into it show with ${plan.name}, added up with the others it pays.`}
                  </p>
                ) : isAccountOfPlan && plan ? (
                  <p className="text-muted-foreground text-sm">Payments show with {plan.name}.</p>
                ) : paid.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {group
                      ? group.account
                        ? "None into its account in the books yet."
                        : "None into the debts it pays yet."
                      : d.booksAccount
                        ? "None in the books yet."
                        : "Link it to its account to see these."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {paid.map((p, i) => (
                      <li key={`${p.date}-${i}`} className="flex justify-between gap-2">
                        <span>
                          {day(p.date)}
                          {p.fromAccount && (
                            <span className="text-muted-foreground"> from {p.fromAccount}</span>
                          )}
                        </span>
                        <span className="tabular-nums">{money(p.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {canEdit && (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold">
                    Change the details
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    {group ? (
                      <>
                        <DebtPlanForm
                          slug={tenant.slug}
                          values={planValues(d)}
                          currency={tenant.currency}
                          candidates={candidatesFor(d.id)}
                          accounts={accountsFor(d.id)}
                        />
                        <p className="text-muted-foreground text-xs">
                          Finished with the plan? Set it to Closed to keep its history, or remove
                          it: either way the debts it paid count on their own again, just as they
                          were.
                        </p>
                        <RowButton
                          slug={tenant.slug}
                          what="debt"
                          id={d.id}
                          label="Remove this plan"
                          confirm={`Remove ${d.name}? The debts it pays count on their own again, just as they were.`}
                        />
                      </>
                    ) : (
                      <>
                        {plan && !isAccountOfPlan && (
                          <UncoverButton slug={tenant.slug} debtId={d.id} name={d.name} />
                        )}
                        <DebtForm
                          slug={tenant.slug}
                          values={formValues(d)}
                          currency={tenant.currency}
                          accounts={accounts}
                          fromBooks={d.source === "books"}
                        />
                        {d.source === "books" && d.bookAccountId ? (
                          <>
                            <p className="text-muted-foreground text-xs">
                              Its name and balance follow your books, and a sync never changes what
                              you fill in here. Not something you&apos;re paying down? Leave it out:
                              it stays out after every sync.
                            </p>
                            <BookChoiceButton
                              slug={tenant.slug}
                              accountId={d.bookAccountId}
                              choice="not_debt"
                              label="Not a debt"
                              variant="ghost"
                            />
                          </>
                        ) : (
                          <>
                            <p className="text-muted-foreground text-xs">
                              Paid off? Set it to Closed to keep its history. Remove it only if it
                              was added by mistake.
                            </p>
                            <RowButton
                              slug={tenant.slug}
                              what="debt"
                              id={d.id}
                              label="Remove this debt"
                              confirm={`Remove ${d.name} and its balances? This can't be undone.`}
                            />
                          </>
                        )}
                      </>
                    )}
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
