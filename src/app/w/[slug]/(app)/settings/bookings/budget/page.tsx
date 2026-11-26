import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { SectionHeading } from "@/components/settings/section-heading";
import { BUDGET_KEY, parseBudgetSettings } from "@/lib/bookings/budget";
import { BOOKINGS_MODULE } from "@/lib/bookings/config";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../../../bookings/gate";
import { saveBudgetSettings, setServiceFrame } from "../../../bookings/studio-actions";
import { StudioForm } from "../../../bookings/studio-form";

export const metadata: Metadata = { title: "Budget" };

/**
 * Settings → Bookings → Budget: who teaches and at what hourly rate, prep and
 * clean-up time, the waste allowance on materials, and each workshop's
 * project size. Owners and admins only, like the budget itself.
 */
export default async function BudgetSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/settings/bookings/budget`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!canManage(role)) notFound();
  const canEdit = entitlements.canWrite;
  const supabase = await createClient();
  const [{ data: config }, { data: services }] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", BOOKINGS_MODULE)
      .eq("key", BUDGET_KEY)
      .maybeSingle(),
    supabase
      .from("services")
      .select("id, name, frame_width_in, frame_height_in")
      .eq("tenant_id", tenant.id)
      .eq("kind", "workshop")
      .order("name"),
  ]);
  const settings = parseBudgetSettings(config?.body);
  const slots = [
    ...settings.teachers,
    ...Array.from({ length: Math.max(0, 10 - settings.teachers.length) }, () => null),
  ].slice(0, Math.min(10, settings.teachers.length + 2));

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/bookings/budget`, label: "Budget" }}
        title="Budget"
        description="What teaching costs, and what goes into the materials for each class."
      />
      <Card>
        <CardHeader>
          <CardTitle>Teaching</CardTitle>
          <CardDescription>
            A class&apos;s teaching is its hours plus prep and clean-up, at the teacher&apos;s
            hourly rate. The first teacher is who teaches a class unless you say otherwise on the
            Budget page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <StudioForm action={saveBudgetSettings.bind(null, tenant.slug)} submit="Save">
              {slots.map((t, i) => (
                <div key={t?.id ?? `empty-${i}`} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name={`teacher_${i}_id`} value={t?.id ?? ""} />
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`teacher-${i}`} className="text-xs">
                      {i === 0 ? "Teacher (usual)" : "Teacher"}
                    </Label>
                    <Input
                      id={`teacher-${i}`}
                      name={`teacher_${i}_name`}
                      defaultValue={t?.name ?? ""}
                      maxLength={60}
                      placeholder={t ? undefined : "Add someone"}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`rate-${i}`} className="text-xs">
                      An hour, $
                    </Label>
                    <Input
                      id={`rate-${i}`}
                      name={`teacher_${i}_rate`}
                      inputMode="decimal"
                      defaultValue={t ? (t.hourly_cents / 100).toFixed(2) : ""}
                      className="w-28"
                    />
                  </div>
                </div>
              ))}
              <p className="text-muted-foreground text-xs">
                Empty a name to take someone off. Classes they taught go back to the usual teacher.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="overhead">Prep and clean-up, hours a class</Label>
                  <Input
                    id="overhead"
                    name="overhead_hours"
                    inputMode="decimal"
                    defaultValue={settings.overhead_hours}
                    className="w-28"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="waste">Waste on materials, %</Label>
                  <Input
                    id="waste"
                    name="waste_percent"
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={settings.waste_percent}
                    className="w-28"
                  />
                </div>
              </div>
            </StudioForm>
          ) : (
            <p className="text-muted-foreground text-sm">This workspace is read-only.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Project size of each workshop</CardTitle>
          <CardDescription>
            The size of what each person makes, in inches, for materials by the square foot. Leave
            at 0 where you don&apos;t price that way.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(
            (services ?? []) as {
              id: string;
              name: string;
              frame_width_in: string;
              frame_height_in: string;
            }[]
          ).map((s) => (
            <StudioForm
              key={s.id}
              action={setServiceFrame.bind(null, tenant.slug, s.id)}
              submit="Save"
              variant="outline"
              className="flex flex-wrap items-end gap-2"
            >
              <span className="w-48 text-sm font-semibold">{s.name}</span>
              <Input
                name="width"
                inputMode="decimal"
                defaultValue={Number(s.frame_width_in)}
                aria-label={`${s.name} width in inches`}
                className="w-20"
              />
              <span className="text-sm">×</span>
              <Input
                name="height"
                inputMode="decimal"
                defaultValue={Number(s.frame_height_in)}
                aria-label={`${s.name} height in inches`}
                className="w-20"
              />
              <span className="text-muted-foreground text-xs">inches</span>
            </StudioForm>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
