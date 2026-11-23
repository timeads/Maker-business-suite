import Link from "next/link";
import {
  CalendarDays,
  Headset,
  LineChart,
  Megaphone,
  MessagesSquare,
  Package,
  Truck,
} from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/site/site-chrome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TRIAL_DAYS } from "@/lib/billing/plans";

/** What a maker might find waiting on Home on an ordinary morning. */
const MORNING = [
  { tool: "Shipping", line: "8 orders ready to pack", tone: "waiting", word: "Today" },
  { tool: "Help desk", line: "1 customer waiting on a reply", tone: "open", word: "Open" },
  { tool: "Stock", line: "3 yarns to reorder by Friday", tone: "waiting", word: "Order soon" },
  { tool: "Bookings", line: "Saturday workshop: 6 of 8 seats", tone: "good", word: "On track" },
  { tool: "Social", line: "2 posts going out this week", tone: "good", word: "Scheduled" },
] as const;

const TOOLS = [
  {
    icon: Truck,
    name: "Shipping",
    line: "Pack and post without the tab-hopping.",
    points: [
      "One queue of what's ready, with holds, pickups and priority set apart",
      "Packing slips your way, and scan-as-you-pack so the right thing goes out",
      "Buy and print postage from the order",
    ],
  },
  {
    icon: Package,
    name: "Stock",
    line: "Know what to reorder before you run out.",
    points: [
      "Order-by dates worked out from what really sells and how long suppliers take",
      "Tick items and get a draft order per supplier, quantities filled in",
      "Check deliveries in, and keep track of what you owe",
    ],
  },
  {
    icon: Headset,
    name: "Help desk",
    line: "Every customer email in one shared inbox.",
    points: [
      "The customer's orders sit beside their message",
      "Saved replies, notes for the team, snooze until later",
      "A first draft from Claude when you want one",
    ],
  },
  {
    icon: CalendarDays,
    name: "Bookings",
    line: "Fill your workshops without the back-and-forth.",
    points: [
      "Dates, seats and a list of who's coming",
      "Sell through your own shop: shoppers pick a date on the product page",
      "Confirmations, reminders and thank-yous sent for you",
    ],
  },
  {
    icon: Megaphone,
    name: "Social and emails",
    line: "A month of posts, in your voice and your colours.",
    points: [
      "Photos and videos in one library, tagged so the right one is found",
      "Plan, schedule and post to Facebook and Instagram",
      "Design marketing emails and pictures from your brand kit",
    ],
  },
  {
    icon: LineChart,
    name: "Money",
    line: "Sales, margins and cash on one page.",
    points: [
      "Figures from your shop and your books, side by side",
      "Best sellers and where your orders come from",
      "Every chart also comes as a plain table",
    ],
  },
  {
    icon: MessagesSquare,
    name: "Messages",
    line: "Team chat that knows what's going on.",
    points: [
      "Channels for the whole studio, direct messages for two",
      "Heads-ups from your other tools, like a new booking",
      "Works on the phone in your apron pocket",
    ],
  },
] as const;

const WORKS_WITH = ["Shopify", "Stripe", "QuickBooks", "Facebook", "Instagram", "EasyPost"];

const PROMISES = [
  {
    title: "Nothing goes out without you",
    body: "Claude can draft a reply, a caption or a whole email. It lands in front of you to edit. Sending is always your button to press.",
  },
  {
    title: "No developer needed",
    body: "Connect your shop by signing in to it. There's nothing to install and no keys to hunt for, except where a service insists.",
  },
  {
    title: "Your look, not ours",
    body: "Tell it your colours and how you sound once. Emails, pictures and drafts follow your brand kit from then on.",
  },
];

export default function HomePage() {
  return (
    <>
      <div className="rail-texture">
        <SiteHeader tone="teal" />
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-10 pb-16 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:pt-16 lg:pb-24">
          <div className="flex flex-col gap-5">
            <h1 className="text-on-teal text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              The back office for people who make things.
            </h1>
            <p className="text-on-teal-2 max-w-xl text-lg">
              Orders to pack, stock to reorder, customers to answer, workshops to fill and posts to
              plan. One place, connected to the shop you already run.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button asChild size="lg">
                <Link href="/login">Get started</Link>
              </Button>
              <Link
                href="/pricing"
                className="text-on-teal rounded-sm px-2 py-2 text-sm font-semibold underline underline-offset-4"
              >
                See pricing
              </Link>
            </div>
            <p className="text-on-teal-2 text-sm">
              Free for {TRIAL_DAYS} days. Change or cancel whenever you like.
            </p>
          </div>

          <div
            className="bg-panel text-foreground rounded-xl p-3 shadow-xl sm:p-4"
            aria-label="An example of the Home page"
          >
            <p className="text-text-2 px-1 pb-2 text-xs font-semibold tracking-wide uppercase">
              Good morning. Here&rsquo;s today.
            </p>
            <ul className="flex flex-col gap-2">
              {MORNING.map((row) => (
                <li
                  key={row.tool}
                  className="bg-card border-border flex items-center gap-3 rounded-lg border px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground text-xs">{row.tool}</p>
                    <p className="truncate text-sm font-medium">{row.line}</p>
                  </div>
                  <Badge tone={row.tone}>{row.word}</Badge>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <main>
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance">
            Seven tools that share what they know.
          </h2>
          <p className="text-muted-foreground mt-2 max-w-2xl text-lg">
            An order shows up in Shipping, counts against Stock, and sits beside the
            customer&rsquo;s email in the Help desk. You type it once, if at all.
          </p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TOOLS.map((tool) => (
              <li
                key={tool.name}
                className="bg-card border-border flex flex-col gap-3 rounded-xl border p-5"
              >
                <div className="flex items-center gap-2.5">
                  <span className="bg-teal-soft text-teal-soft-ink grid size-9 place-items-center rounded-lg">
                    <tool.icon className="size-[18px]" aria-hidden />
                  </span>
                  <h3 className="text-base font-semibold">{tool.name}</h3>
                </div>
                <p className="font-medium">{tool.line}</p>
                <ul className="text-muted-foreground flex list-disc flex-col gap-1.5 pl-4 text-sm">
                  {tool.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </li>
            ))}
            <li className="bg-note border-note-border flex flex-col justify-center gap-2 rounded-xl border p-5">
              <h3 className="text-base font-semibold">And an assistant</h3>
              <p className="text-sm">
                Ask &ldquo;what sold best last month?&rdquo; in your own words, or have it suggest a
                change to your settings for you to approve.
              </p>
            </li>
          </ul>
        </section>

        <section className="bg-sunken">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 sm:px-6 md:grid-cols-3">
            {PROMISES.map((promise) => (
              <div key={promise.title} className="flex flex-col gap-2">
                <h2 className="text-xl font-semibold tracking-tight">{promise.title}</h2>
                <p className="text-text-2">{promise.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">Works with what you already use</h2>
          <ul className="mt-5 flex flex-wrap gap-2">
            {WORKS_WITH.map((name) => (
              <li
                key={name}
                className="bg-card border-border rounded-full border px-4 py-1.5 text-sm font-medium"
              >
                {name}
              </li>
            ))}
          </ul>
          <div className="border-border mt-12 grid gap-6 border-t pt-10 md:grid-cols-2">
            <div className="flex flex-col items-start gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">One price for the lot</h2>
              <p className="text-muted-foreground">
                Simple monthly plans, {TRIAL_DAYS} days free, change or cancel whenever you like.
              </p>
              <Button asChild variant="outline">
                <Link href="/pricing">See the plans</Link>
              </Button>
            </div>
            <div className="flex flex-col items-start gap-3">
              <h2 className="text-2xl font-semibold tracking-tight">Stuck on something?</h2>
              <p className="text-muted-foreground">
                Short how-tos for every tool, from connecting your shop to buying a postage label.
              </p>
              <Button asChild variant="outline">
                <Link href="/help">Open the help pages</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
