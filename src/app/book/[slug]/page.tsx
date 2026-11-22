import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { bookingsConfigured, getPublicWorkspace, listPublicServices } from "@/lib/bookings/server";
import { BookingShell, durationLabel, priceLabel } from "../shell";

export const metadata: Metadata = { title: "Book", robots: { index: false } };

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { slug } = await params;
  const embed = (await searchParams).embed === "1";
  if (!bookingsConfigured()) notFound();
  const tenant = await getPublicWorkspace(slug);
  if (!tenant) notFound();
  const services = await listPublicServices(tenant.id);
  const suffix = embed ? "?embed=1" : "";

  return (
    <BookingShell workspaceName={tenant.name} embed={embed}>
      <h1 className="text-3xl font-semibold tracking-tight">Book with {tenant.name}</h1>
      {services.length === 0 ? (
        <p className="text-muted-foreground">
          There&apos;s nothing to book just yet. Check back soon.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {services.map((service) => (
            <li key={service.id}>
              <Link href={`/book/${tenant.slug}/${service.slug}${suffix}`} className="group block">
                <Card className="group-hover:border-primary transition-colors">
                  <CardHeader>
                    <CardTitle>{service.name}</CardTitle>
                    <CardDescription>
                      {service.kind === "workshop" ? "Workshop" : "Appointment"} ·{" "}
                      {durationLabel(service.duration_minutes)} ·{" "}
                      {priceLabel(service.price_cents, tenant.currency)}
                      {service.kind === "workshop" && service.price_cents > 0 ? " per place" : ""}
                    </CardDescription>
                    {service.description && (
                      <p className="text-sm whitespace-pre-line">{service.description}</p>
                    )}
                  </CardHeader>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </BookingShell>
  );
}
