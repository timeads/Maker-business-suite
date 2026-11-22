import { NextResponse } from "next/server";
import { readAnswers } from "@/lib/bookings/config";
import {
  bookingsConfigured,
  getBookingForm,
  getPublicService,
  getPublicWorkspace,
  reserve,
} from "@/lib/bookings/server";
import { getSiteUrl } from "@/lib/site-url";
import { emailSchema } from "@/lib/validation";

const isValidEmail = (value: string) => emailSchema.safeParse(value).success;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The public booking form posts here. Always answers with a redirect. */
export async function POST(request: Request) {
  const site = await getSiteUrl();
  const formData = await request.formData();
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  const go = (url: string) => NextResponse.redirect(url, 303);

  if (!bookingsConfigured()) return go(site);
  const tenant = await getPublicWorkspace(field("workspace"));
  if (!tenant) return go(site);
  const service = await getPublicService(tenant.id, field("service"));
  if (!service) return go(`${site}/book/${tenant.slug}`);
  const back = (error: string) => go(`${site}/book/${tenant.slug}/${service.slug}?error=${error}`);

  // Bots fill in every field they find.
  if (field("website")) return back("failed");

  const name = field("name").trim();
  const email = field("email").trim().toLowerCase();
  const seats = Number.parseInt(field("seats") || "1", 10);
  const sessionId = field("session");
  if (!name || name.length > 120 || !isValidEmail(email)) return back("details");
  if (!Number.isInteger(seats) || seats < 1 || seats > 10) return back("details");
  if (service.kind === "workshop" && !UUID.test(sessionId)) return back("gone");

  const answers = readAnswers(await getBookingForm(tenant.id), field);
  if ("error" in answers) return back("details");

  const result = await reserve({
    tenant,
    service,
    sessionId: service.kind === "workshop" ? sessionId : null,
    startsAt: service.kind === "appointment" ? field("starts_at") : null,
    name,
    email,
    seats,
    answers: answers.answers,
  });
  return result.ok ? go(result.redirectTo) : back(result.reason);
}
