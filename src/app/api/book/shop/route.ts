import { bookingsConfigured, getShopBookingDates } from "@/lib/bookings/server";

// Read by the date picker on a shop's product page, which lives on the
// shop's own address: so this answers any origin, and only ever says what a
// shopper could see anyway (a workshop's name, its dates and the seats left).
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=20",
  "Content-Type": "application/json",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("workspace") ?? "";
  const product = url.searchParams.get("product") ?? "";
  // "We can't tell" is never answered as "not a workshop": the picker shows
  // its plain message instead of leaving a shopper with nothing.
  if (!bookingsConfigured()) {
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { ...HEADERS, "Cache-Control": "no-store" },
    });
  }
  try {
    const dates = await getShopBookingDates(slug, product);
    return new Response(JSON.stringify(dates ? { found: true, ...dates } : { found: false }), {
      status: 200,
      headers: HEADERS,
    });
  } catch (err) {
    console.error(`Shop dates failed: ${err instanceof Error ? err.message : "unknown"}`);
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { ...HEADERS, "Cache-Control": "no-store" },
    });
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}
