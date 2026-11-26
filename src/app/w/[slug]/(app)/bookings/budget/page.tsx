import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import {
  BUDGET_KEY,
  PERIODS,
  PERIOD_NAMES,
  budgetTotals,
  dollars,
  fixedForMonths,
  materialsPerStudent,
  parseBudgetSettings,
  periodFor,
  sessionCosts,
  sqftRate,
  type BudgetSession,
} from "@/lib/bookings/budget";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { formatWhen, localDay, zonedTimeToUtc } from "@/lib/bookings/slots";
import { loadClassRuns } from "@/lib/bookings/studio-data";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { bookingsAccess } from "../gate";
import {
  deleteBudgetRow,
  saveFixedCost,
  saveMaterialRate,
  saveOtherIncome,
  setSessionCosts,
} from "../studio-actions";
import { StudioForm } from "../studio-form";

export const metadata: Metadata = { title: "Budget" };

type Fixed = {
  id: string;
  name: string;
  monthly_cents: number;
  from_month: string;
  to_month: string | null;
  active: boolean;
};
type Rate = { id: string; name: string; centi_cents_per_sqft: number; active: boolean };
type Income = { id: string; label: string; amount_cents: number; received_on: string };
type Costs = NonNullable<BudgetSession["costs"]> & { session_id: string };

const money = (cents: number) => (cents / 100).toFixed(2);

/**
 * The budget: what the classes in a period brought in against what they
 * cost. Owners and admins only. Every figure is worked out as the page is
 * drawn (lib/bookings/budget.ts); only what a person typed in is stored.
 */
export default async function BudgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/budget`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!canManage(role)) notFound();
  const canEdit = entitlements.canWrite;
  const now = new Date();
  const today = localDay(now, tenant.timezone);
  const chosen = (await searchParams).period ?? "this_month";
  const period = periodFor(chosen, today);
  const startAt =
    zonedTimeToUtc(period.from, 0, tenant.timezone) ?? new Date(`${period.from}T00:00:00Z`);
  const endAt =
    zonedTimeToUtc(period.until, 0, tenant.timezone) ?? new Date(`${period.until}T00:00:00Z`);

  const supabase = await createClient();
  const [config, fixed, rates, income, services, costs, supplies, links, paid, runs] =
    await Promise.all([
      supabase
        .from("configs")
        .select("body")
        .eq("tenant_id", tenant.id)
        .eq("module", BOOKINGS_MODULE)
        .eq("key", BUDGET_KEY)
        .maybeSingle(),
      supabase
        .from("budget_fixed_costs")
        .select("id, name, monthly_cents, from_month, to_month, active")
        .eq("tenant_id", tenant.id)
        .order("name"),
      supabase
        .from("budget_material_rates")
        .select("id, name, centi_cents_per_sqft, active")
        .eq("tenant_id", tenant.id)
        .order("name"),
      supabase
        .from("budget_other_income")
        .select("id, label, amount_cents, received_on")
        .eq("tenant_id", tenant.id)
        .gte("received_on", period.from)
        .lt("received_on", period.until)
        .order("received_on"),
      supabase
        .from("services")
        .select("id, name, frame_width_in, frame_height_in")
        .eq("tenant_id", tenant.id),
      supabase
        .from("session_costs")
        .select("session_id, teacher, teaching_cents, frame_width_in, frame_height_in")
        .eq("tenant_id", tenant.id),
      supabase
        .from("class_supplies")
        .select("id, active, per_student, unit_cost_cents")
        .eq("tenant_id", tenant.id),
      supabase
        .from("class_supply_services")
        .select("supply_id, service_id")
        .eq("tenant_id", tenant.id),
      // Money in from bookings: what each confirmed booking paid, by the day it was made.
      supabase
        .from("bookings")
        .select("amount_cents")
        .eq("tenant_id", tenant.id)
        .eq("status", "confirmed")
        .gte("confirmed_at", startAt.toISOString())
        .lt("confirmed_at", endAt.toISOString())
        .limit(10000),
      loadClassRuns(supabase, tenant.id, startAt, endAt),
    ]);

  const settings = parseBudgetSettings(config.data?.body);
  const serviceRows = (services.data ?? []) as {
    id: string;
    name: string;
    frame_width_in: string | number;
    frame_height_in: string | number;
  }[];
  const serviceById = new Map(serviceRows.map((s) => [s.id, s]));
  const costRows = new Map(
    ((costs.data ?? []) as Record<string, unknown>[]).map((c) => [
      String(c.session_id),
      {
        teacher: (c.teacher as string | null) ?? null,
        teaching_cents: c.teaching_cents === null ? null : Number(c.teaching_cents),
        frame_width_in: c.frame_width_in === null ? null : Number(c.frame_width_in),
        frame_height_in: c.frame_height_in === null ? null : Number(c.frame_height_in),
      } satisfies Omit<Costs, "session_id">,
    ]),
  );
  const sessions: BudgetSession[] = runs.map((run) => ({
    id: run.id,
    service_id: run.service_id,
    starts_at: run.starts_at,
    ends_at: run.ends_at,
    cancelled: run.cancelled,
    seats: run.seats,
    frame_width_in: Number(serviceById.get(run.service_id)?.frame_width_in ?? 0),
    frame_height_in: Number(serviceById.get(run.service_id)?.frame_height_in ?? 0),
    costs: costRows.get(run.id) ?? null,
  }));
  const fixedRows = (fixed.data ?? []) as Fixed[];
  const rateRows = (rates.data ?? []) as Rate[];
  const incomeRows = (income.data ?? []) as Income[];
  const perStudent = materialsPerStudent(
    ((supplies.data ?? []) as Record<string, unknown>[]).map((s) => ({
      id: String(s.id),
      active: Boolean(s.active),
      per_student: Number(s.per_student),
      unit_cost_cents: Number(s.unit_cost_cents),
    })),
    (links.data ?? []) as { supply_id: string; service_id: string }[],
  );
  const rows = sessionCosts(sessions, {
    settings,
    perStudent,
    sqftCentiCents: sqftRate(rateRows),
    now,
  });
  const bookingCents = ((paid.data ?? []) as { amount_cents: number }[]).reduce(
    (sum, b) => sum + (b.amount_cents ?? 0),
    0,
  );
  const otherCents = incomeRows.reduce((sum, i) => sum + i.amount_cents, 0);
  const totals = budgetTotals(
    rows,
    fixedForMonths(fixedRows, period.begun),
    bookingCents,
    otherCents,
  );
  const cur = tenant.currency;
  const teacherName = new Map(settings.teachers.map((t) => [t.id, t.name]));
  const startsTogether = (row: (typeof rows)[number]) =>
    rows
      .filter((other) => other.session.starts_at === row.session.starts_at)
      .map((other) => other.session.id);
  const base = `/w/${tenant.slug}/bookings/budget`;

  const chip = (key: string, label: string) => (
    <Link
      key={key}
      href={`${base}?period=${key}`}
      aria-current={chosen === key ? "true" : undefined}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-semibold transition-colors duration-150",
        chosen === key ? "border-teal bg-teal text-on-teal" : "border-input bg-card hover:bg-hover",
      )}
    >
      {label}
    </Link>
  );
  const stat = (label: string, value: string, sub?: string, tone?: "good" | "bad") => (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-5">
        <span className="text-muted-foreground text-xs font-semibold">{label}</span>
        <span
          className={cn(
            "text-2xl font-bold tabular-nums",
            tone === "bad" && "text-brick",
            tone === "good" && "text-teal",
          )}
        >
          {value}
        </span>
        {sub && <span className="text-muted-foreground text-xs">{sub}</span>}
      </CardContent>
    </Card>
  );
  const prevMonth = (() => {
    const [y, m] = period.months[0].split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();
  const nextMonth = (() => {
    const [y, m] = period.months[period.months.length - 1].split("-").map(Number);
    const d = new Date(Date.UTC(y, m, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();

  return (
    <>
      <PageHeader
        title="Budget"
        description="What your classes brought in against what they cost: fixed costs, teaching and materials."
      />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link href={`${base}?period=${prevMonth}`} className="hover:underline">
            ← {periodFor(prevMonth, today).label}
          </Link>
          <span className="text-lg font-semibold">{period.label}</span>
          <Link href={`${base}?period=${nextMonth}`} className="hover:underline">
            {periodFor(nextMonth, today).label} →
          </Link>
        </div>
        <nav aria-label="Period" className="flex flex-wrap gap-1.5">
          {PERIODS.map((key) => chip(key, PERIOD_NAMES[key]))}
        </nav>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {stat(
          "Money in",
          dollars(totals.revenue_cents, cur),
          otherCents > 0
            ? `${dollars(bookingCents, cur)} from bookings + ${dollars(otherCents, cur)} other`
            : "From bookings made in this period",
        )}
        {stat("Costs", dollars(totals.costs_cents, cur))}
        {stat(
          "What's left",
          dollars(totals.net_cents, cur),
          undefined,
          totals.net_cents >= 0 ? "good" : "bad",
        )}
        {stat("Margin", totals.margin === null ? "—" : `${totals.margin}%`)}
        {stat(
          "People taught",
          String(totals.students),
          `across ${totals.classes} class${totals.classes === 1 ? "" : "es"} so far`,
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Where the money goes</CardTitle>
          <CardDescription>
            Teaching and materials count once a class has happened; fixed costs count for each month
            that has begun. Nothing still to come counts yet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm">
            {[
              [
                period.begun.length < period.months.length
                  ? `Fixed costs (${period.begun.length} of ${period.months.length} months so far)`
                  : "Fixed costs",
                totals.fixed_cents,
              ],
              [
                `Teaching (${rows.filter((r) => !r.upcoming).length} classes)`,
                totals.teaching_cents,
              ],
              ["Materials", totals.materials_cents],
            ].map(([label, value]) => (
              <li key={String(label)} className="flex justify-between gap-3">
                <span>{label}</span>
                <span className="tabular-nums">{dollars(Number(value), cur)}</span>
              </li>
            ))}
            <li className="border-border flex justify-between gap-3 border-t pt-2 font-bold">
              <span>All costs</span>
              <span className="tabular-nums">{dollars(totals.costs_cents, cur)}</span>
            </li>
          </ul>
          <p className="text-muted-foreground mt-3 text-xs">
            Money in is what bookings made in this period paid (shop orders and your own booking
            pages), plus other income below. Teaching rates, prep time and waste are in{" "}
            <Link href={`/w/${tenant.slug}/settings/bookings/budget`} className="underline">
              Settings → Bookings → Budget
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Each class</CardTitle>
          <CardDescription>
            Classes that start together with the same teacher pay that teacher once, on the longest
            class.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No classes in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">Class</th>
                    <th className="py-2 pr-4 font-semibold">People</th>
                    <th className="py-2 pr-4 font-semibold">Teacher</th>
                    <th className="py-2 pr-4 text-right font-semibold">Teaching</th>
                    <th className="py-2 pr-4 text-right font-semibold">Materials</th>
                    <th className="py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {rows.map((row) => {
                    const together = startsTogether(row);
                    return (
                      <tr key={row.session.id} className="align-top">
                        <td className="py-2.5 pr-4">
                          <Link
                            href={`/w/${tenant.slug}/bookings/sessions/${row.session.id}`}
                            className="font-semibold hover:underline"
                          >
                            {serviceById.get(row.session.service_id)?.name ?? "A class"}
                          </Link>
                          <span className="text-muted-foreground block text-xs">
                            {formatWhen(
                              row.session.starts_at,
                              row.session.ends_at,
                              tenant.timezone,
                            )}
                            {row.frame ? ` · ${row.frame}` : ""}
                          </span>
                          {row.upcoming && <Badge tone="open">Still to come</Badge>}
                        </td>
                        <td className="py-2.5 pr-4 tabular-nums">{row.session.seats}</td>
                        <td className="py-2.5 pr-4">
                          {canEdit ? (
                            <StudioForm
                              action={setSessionCosts.bind(null, tenant.slug, [
                                row.session.id,
                                ...together.filter((id) => id !== row.session.id),
                              ])}
                              submit="Save"
                              variant="ghost"
                              className="flex flex-wrap items-center gap-2"
                            >
                              <Select
                                name="teacher"
                                defaultValue={row.teacher}
                                aria-label="Who taught it"
                                className="w-36"
                              >
                                {settings.teachers.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                  </option>
                                ))}
                              </Select>
                              <Input
                                name="fee"
                                inputMode="decimal"
                                placeholder="Flat fee"
                                aria-label="A flat teaching fee instead of hours"
                                defaultValue={
                                  row.session.costs?.teaching_cents != null
                                    ? money(row.session.costs.teaching_cents)
                                    : ""
                                }
                                className="w-24"
                              />
                              {together.length > 1 && (
                                <label className="flex items-center gap-1 text-xs">
                                  <input type="checkbox" name="together" defaultChecked />
                                  and the {together.length - 1} at the same time
                                </label>
                              )}
                            </StudioForm>
                          ) : (
                            teacherName.get(row.teacher)
                          )}
                          {row.shared_teacher && (
                            <span className="text-muted-foreground block text-xs">
                              Paid on the longer class at this time
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">
                          {dollars(row.teaching_cents, cur)}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">
                          {dollars(row.materials_cents, cur)}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {dollars(row.total_cents, cur)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fixed monthly costs</CardTitle>
          <CardDescription>
            Rent, insurance, software. Give the months a cost runs from and to, and each month is
            priced at what it was then.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {fixedRows.map((f) => (
            <div key={f.id} className="border-border flex flex-col gap-2 border-b pb-3">
              {canEdit ? (
                <StudioForm
                  action={saveFixedCost.bind(null, tenant.slug, f.id)}
                  submit="Save"
                  variant="outline"
                  className="flex flex-wrap items-end gap-2"
                >
                  <FixedFields cost={f} prefix={f.id} />
                  <label className="flex items-center gap-1 text-xs">
                    <input type="checkbox" name="active" defaultChecked={f.active} /> Counting
                  </label>
                </StudioForm>
              ) : (
                <p className="text-sm">
                  {f.name}: {dollars(f.monthly_cents, cur)} a month
                </p>
              )}
              {canEdit && (
                <StudioForm
                  action={deleteBudgetRow.bind(null, tenant.slug, "fixed", f.id)}
                  submit="Remove"
                  variant="danger"
                />
              )}
            </div>
          ))}
          {canEdit && (
            <StudioForm
              action={saveFixedCost.bind(null, tenant.slug, null)}
              submit="Add the cost"
              variant="outline"
              className="flex flex-wrap items-end gap-2"
            >
              <FixedFields prefix="new-fixed" />
            </StudioForm>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Materials by the square foot</CardTitle>
          <CardDescription>
            What a square foot of a project costs in each material. Added together, times each
            workshop&apos;s project size (set on the workshop) and the waste allowance.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rateRows.map((r) => (
            <div key={r.id} className="border-border flex flex-col gap-2 border-b pb-3">
              {canEdit ? (
                <>
                  <StudioForm
                    action={saveMaterialRate.bind(null, tenant.slug, r.id)}
                    submit="Save"
                    variant="outline"
                    className="flex flex-wrap items-end gap-2"
                  >
                    <RateFields rate={r} prefix={r.id} />
                    <label className="flex items-center gap-1 text-xs">
                      <input type="checkbox" name="active" defaultChecked={r.active} /> Counting
                    </label>
                  </StudioForm>
                  <StudioForm
                    action={deleteBudgetRow.bind(null, tenant.slug, "material", r.id)}
                    submit="Remove"
                    variant="danger"
                  />
                </>
              ) : (
                <p className="text-sm">
                  {r.name}: ${(r.centi_cents_per_sqft / 10000).toFixed(4)} a square foot
                </p>
              )}
            </div>
          ))}
          {canEdit && (
            <StudioForm
              action={saveMaterialRate.bind(null, tenant.slug, null)}
              submit="Add the material"
              variant="outline"
              className="flex flex-wrap items-end gap-2"
            >
              <RateFields prefix="new-rate" />
            </StudioForm>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Other income, {period.label}</CardTitle>
          <CardDescription>
            Money that didn&apos;t come through a booking here, like a private class paid by
            invoice.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {incomeRows.map((i) => (
            <div key={i.id} className="border-border flex flex-col gap-2 border-b pb-3">
              {canEdit ? (
                <>
                  <StudioForm
                    action={saveOtherIncome.bind(null, tenant.slug, i.id)}
                    submit="Save"
                    variant="outline"
                    className="flex flex-wrap items-end gap-2"
                  >
                    <IncomeFields income={i} prefix={i.id} />
                  </StudioForm>
                  <StudioForm
                    action={deleteBudgetRow.bind(null, tenant.slug, "income", i.id)}
                    submit="Remove"
                    variant="danger"
                  />
                </>
              ) : (
                <p className="text-sm">
                  {i.received_on} {i.label}: {dollars(i.amount_cents, cur)}
                </p>
              )}
            </div>
          ))}
          {canEdit && (
            <StudioForm
              action={saveOtherIncome.bind(null, tenant.slug, null)}
              submit="Add the income"
              variant="outline"
              className="flex flex-wrap items-end gap-2"
            >
              <IncomeFields prefix="new-income" today={today} />
            </StudioForm>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Box({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  );
}

function FixedFields({ cost, prefix }: { cost?: Fixed; prefix: string }) {
  const month = (value: string | null | undefined) =>
    value && value !== "2000-01-01" ? value.slice(0, 7) : "";
  return (
    <>
      <Box id={`${prefix}-name`} label="What">
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={cost?.name}
          maxLength={120}
          required
        />
      </Box>
      <Box id={`${prefix}-amount`} label="A month, $">
        <Input
          id={`${prefix}-amount`}
          name="amount"
          inputMode="decimal"
          defaultValue={cost ? money(cost.monthly_cents) : ""}
          className="w-28"
          required
        />
      </Box>
      <Box id={`${prefix}-from`} label="From (month)">
        <Input
          id={`${prefix}-from`}
          name="from"
          type="month"
          defaultValue={month(cost?.from_month)}
        />
      </Box>
      <Box id={`${prefix}-to`} label="Until (month)">
        <Input id={`${prefix}-to`} name="to" type="month" defaultValue={month(cost?.to_month)} />
      </Box>
    </>
  );
}

function RateFields({ rate, prefix }: { rate?: Rate; prefix: string }) {
  return (
    <>
      <Box id={`${prefix}-name`} label="Material">
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={rate?.name}
          maxLength={120}
          required
        />
      </Box>
      <Box id={`${prefix}-rate`} label="$ a square foot">
        <Input
          id={`${prefix}-rate`}
          name="rate"
          inputMode="decimal"
          defaultValue={rate ? String(rate.centi_cents_per_sqft / 10000) : ""}
          className="w-28"
          required
        />
      </Box>
    </>
  );
}

function IncomeFields({
  income,
  prefix,
  today,
}: {
  income?: Income;
  prefix: string;
  today?: string;
}) {
  return (
    <>
      <Box id={`${prefix}-label`} label="What">
        <Input
          id={`${prefix}-label`}
          name="label"
          defaultValue={income?.label}
          maxLength={120}
          required
        />
      </Box>
      <Box id={`${prefix}-amount`} label="Amount, $">
        <Input
          id={`${prefix}-amount`}
          name="amount"
          inputMode="decimal"
          defaultValue={income ? money(income.amount_cents) : ""}
          className="w-28"
          required
        />
      </Box>
      <Box id={`${prefix}-day`} label="Came in on">
        <Input
          id={`${prefix}-day`}
          name="received_on"
          type="date"
          defaultValue={income?.received_on ?? today}
          required
        />
      </Box>
    </>
  );
}
