import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../gate";
import { deleteVendor, saveVendor } from "../studio-actions";
import { StudioForm } from "../studio-form";

export const metadata: Metadata = { title: "Vendors" };

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";

type Vendor = { id: string; name: string; email: string; website: string; note: string };

function VendorFields({ vendor, prefix }: { vendor?: Vendor; prefix: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${prefix}-name`}>Name</Label>
        <Input
          id={`${prefix}-name`}
          name="name"
          defaultValue={vendor?.name}
          maxLength={120}
          required
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${prefix}-email`}>Email</Label>
        <Input id={`${prefix}-email`} name="email" type="email" defaultValue={vendor?.email} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${prefix}-site`}>Website</Label>
        <Input
          id={`${prefix}-site`}
          name="website"
          type="url"
          placeholder="https://"
          defaultValue={vendor?.website}
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-3">
        <Label htmlFor={`${prefix}-note`}>How you order</Label>
        <textarea
          id={`${prefix}-note`}
          name="note"
          rows={2}
          maxLength={2000}
          defaultValue={vendor?.note}
          placeholder="A portal, a rep's name, a minimum order…"
          className={textarea}
        />
      </div>
    </div>
  );
}

/** Who classroom supplies come from, with how to order from each. */
export default async function VendorsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/vendors`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  const supabase = await createClient();
  const [{ data: vendors }, { data: supplies }] = await Promise.all([
    supabase
      .from("class_vendors")
      .select("id, name, email, website, note")
      .eq("tenant_id", tenant.id)
      .order("name"),
    supabase.from("class_supplies").select("vendor_id, name").eq("tenant_id", tenant.id),
  ]);
  const list = (vendors ?? []) as Vendor[];
  const itemsOf = (id: string) =>
    ((supplies ?? []) as { vendor_id: string | null; name: string }[])
      .filter((s) => s.vendor_id === id)
      .map((s) => s.name);

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Who your classroom supplies come from, and how to order from each."
      />
      {list.length === 0 && <p className="text-muted-foreground text-sm">No vendors yet.</p>}
      {list.map((vendor) => (
        <Card key={vendor.id}>
          <CardHeader>
            <CardTitle>{vendor.name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              {itemsOf(vendor.id).join(", ") || "No supplies from them yet."}
            </p>
            {!manager ? (
              <div className="font-read flex flex-col gap-1">
                {vendor.email && <span>{vendor.email}</span>}
                {vendor.website && (
                  <a
                    href={vendor.website}
                    className="underline"
                    rel="noreferrer noopener"
                    target="_blank"
                  >
                    {vendor.website}
                  </a>
                )}
                {vendor.note && <span className="whitespace-pre-line">{vendor.note}</span>}
              </div>
            ) : (
              <>
                <StudioForm
                  action={saveVendor.bind(null, tenant.slug, vendor.id)}
                  submit="Save"
                  variant="outline"
                >
                  <VendorFields vendor={vendor} prefix={vendor.id} />
                </StudioForm>
                <StudioForm
                  action={deleteVendor.bind(null, tenant.slug, vendor.id)}
                  submit="Remove this vendor"
                  variant="danger"
                />
              </>
            )}
          </CardContent>
        </Card>
      ))}
      {manager && (
        <Card>
          <CardHeader>
            <CardTitle>Add a vendor</CardTitle>
          </CardHeader>
          <CardContent>
            <StudioForm action={saveVendor.bind(null, tenant.slug, null)} submit="Add the vendor">
              <VendorFields prefix="new" />
            </StudioForm>
          </CardContent>
        </Card>
      )}
    </>
  );
}
