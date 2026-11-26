import { bookingsConfigured, getUpcomingClasses } from "@/lib/bookings/server";

// Read by the "Upcoming classes" list on a shop's own workshops page, which
// lives on the shop's address: so this answers any origin, and only ever says
// what a shopper could see on the product pages anyway (workshop names, open
// dates, places left and the products' own shop pages). Cached for a minute
// at the edge and in the browser; the server keeps its answer half a minute.
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
  "Content-Type": "application/json",
};

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("workspace") ?? "";
  if (!bookingsConfigured()) {
    return new Response(JSON.stringify({ error: "unavailable" }), {
      status: 503,
      headers: { ...HEADERS, "Cache-Control": "no-store" },
    });
  }
  try {
    const answer = await getUpcomingClasses(slug);
    return new Response(JSON.stringify(answer ?? { found: false }), {
      status: 200,
      headers: HEADERS,
    });
  } catch (err) {
    console.error(`Upcoming classes failed: ${err instanceof Error ? err.message : "unknown"}`);
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
