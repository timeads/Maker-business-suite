import Link from "next/link";
import {
  ArrowRight,
  CalendarDays,
  Check,
  Headset,
  LineChart,
  Megaphone,
  MessagesSquare,
  Package,
  Sparkles,
  Truck,
} from "lucide-react";
import { PlanCards } from "@/components/plan-cards";
import { SiteFooter } from "@/components/site/site-chrome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TRIAL_DAYS } from "@/lib/billing/plans";

/** What a maker might find waiting on Home on an ordinary morning. */
const MORNING = [
  { icon: Truck, tool: "Shipping", line: "8 orders ready to pack", tone: "waiting", word: "Today" },
  { icon: Headset, tool: "Help desk", line: "1 customer waiting", tone: "open", word: "Open" },
  { icon: Package, tool: "Stock", line: "3 yarns to reorder", tone: "bad", word: "Order soon" },
  {
    icon: CalendarDays,
    tool: "Bookings",
    line: "Saturday workshop: 6 of 8 seats",
    tone: "good",
    word: "On track",
  },
  {
    icon: Megaphone,
    tool: "Social",
    line: "2 posts going out this week",
    tone: "closed",
    word: "Scheduled",
  },
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
    note: "Postage through your own EasyPost account",
    help: "to-ship",
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
    note: "Cases and smallest orders respected",
    help: "reorder-suggestions",
  },
  {
    icon: Headset,
    name: "Help desk",
    line: "Every customer email in one shared inbox.",
    points: [
      "The customer's orders sit right beside their message",
      "Saved replies, notes for the team, snooze until later",
      "A first draft from Claude when you want one",
    ],
    note: "Works with the email address you already have",
    help: "support-address",
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
    note: "No commission per seat",
    help: "workshops",
  },
  {
    icon: Megaphone,
    name: "Social & emails",
    line: "A month of posts, in your voice and your colours.",
    points: [
      "Photos and videos in one library, tagged so the right one is found",
      "Plan, schedule and post to Facebook and Instagram",
      "Design marketing emails and pictures from your brand kit",
    ],
    note: "Facebook and Instagram",
    help: "write-a-post",
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
    note: "Reads your shop and QuickBooks",
    help: "money",
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
    note: "For your whole team",
    help: "messages",
  },
] as const;

const WORKS_WITH = ["Shopify", "Stripe", "QuickBooks", "Facebook & Instagram", "EasyPost"];

const STEPS = [
  {
    title: "Connect your shop",
    body: "Sign in to Shopify once. Your orders, products and stock counts come in by themselves.",
  },
  {
    title: "Work the morning list",
    body: "Home says what's waiting: orders to pack, customers to answer, things to reorder.",
  },
  {
    title: "Let it do the remembering",
    body: "Reminders go to workshop guests, holds come back on their day, and reorder dates move with your sales.",
  },
];

const EYEBROW = "text-xs font-semibold tracking-[0.08em] uppercase";
const DISPLAY = "font-display font-normal tracking-normal text-balance";

export default function HomePage() {
  return (
    <>
      <div className="rail-texture text-on-teal">
        <header className="border-b border-white/10">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-4 sm:px-6">
            <Link href="/" className="font-display text-xl leading-none">
              Maker Business Suite
            </Link>
            <nav
              aria-label="Site"
              className="text-on-teal-2 ml-auto hidden items-center gap-6 text-sm font-medium md:flex"
            >
              <a href="#tools" className="hover:text-on-teal">
                The 7 tools
              </a>
              <a href="#how" className="hover:text-on-teal">
                How it works
              </a>
              <a href="#pricing" className="hover:text-on-teal">
                Pricing
              </a>
              <Link href="/help" className="hover:text-on-teal">
                Help
              </Link>
            </nav>
            <Link
              href="/login"
              className="hover:text-on-teal ml-auto text-sm font-semibold md:ml-0"
            >
              Sign in
            </Link>
          </div>
        </header>

        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:pt-20 lg:pb-24">
          <div className="flex min-w-0 flex-col items-start gap-6">
            <p className={`${EYEBROW} rounded-full bg-white/10 px-3 py-1.5`}>
              Made for independent makers and small studios
            </p>
            <h1 className={`${DISPLAY} text-4xl leading-[1.1] sm:text-5xl lg:text-[3.5rem]`}>
              The back office for people who{" "}
              <span className="text-mint-soft italic">make things.</span>
            </h1>
            <p className="text-on-teal-2 max-w-xl text-lg">
              Orders to pack, stock to reorder, customers to answer, workshops to fill and posts to
              plan. One calm place, connected to the shop you already run.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link href="/login">
                  Get started free <ArrowRight aria-hidden />
                </Link>
              </Button>
              <a
                href="#pricing"
                className="text-on-teal flex h-10 items-center rounded-sm bg-white/10 px-5 text-sm font-semibold hover:bg-white/15"
              >
                See pricing
              </a>
            </div>
            <p className="text-on-teal-2 flex items-center gap-2 text-sm">
              <Check className="text-mint-soft size-4" aria-hidden />
              Free for {TRIAL_DAYS} days. Change or cancel whenever you like.
            </p>
          </div>

          <div
            className="bg-card text-foreground min-w-0 rounded-xl p-5 shadow-2xl sm:p-6"
            aria-label="An example of the Home page"
          >
            <div className="border-border flex items-end justify-between gap-3 border-b pb-4">
              <div>
                <p className={`${EYEBROW} text-muted-foreground`}>Today in the studio</p>
                <p className="font-display mt-1 text-xl">Good morning</p>
              </div>
              <span className="bg-sunken text-text-2 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium">
                <span className="bg-mint-ink size-1.5 rounded-full" aria-hidden /> Shop connected
              </span>
            </div>
            <ul className="divide-border flex flex-col divide-y">
              {MORNING.map((row) => (
                <li key={row.tool} className="flex items-center gap-3 py-3">
                  <span className="bg-sunken text-text-2 grid size-9 shrink-0 place-items-center rounded-lg">
                    <row.icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground text-xs">{row.tool}</p>
                    <p className="truncate text-sm font-semibold">{row.line}</p>
                  </div>
                  <Badge tone={row.tone}>{row.word}</Badge>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground border-border border-t pt-4 text-xs">
              An example of Home. Yours shows your own orders, customers and dates.
            </p>
          </div>
        </section>
      </div>

      <section className="bg-sunken">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-12 gap-y-4 px-4 py-8 sm:px-6">
          <div>
            <p className={`${EYEBROW} text-muted-foreground`}>Works with what you use</p>
            <p className="font-display mt-1 text-lg">Your shop, your books, your channels</p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {WORKS_WITH.map((name) => (
              <li
                key={name}
                className="bg-card border-border rounded-md border px-4 py-2 text-sm font-medium"
              >
                {name}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <main>
        <section id="tools" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-20 sm:px-6">
          <p className={`${EYEBROW} bg-mint-soft text-mint-ink w-fit rounded-sm px-3 py-1.5`}>
            One place for the whole studio
          </p>
          <h2 className={`${DISPLAY} mt-4 text-3xl sm:text-4xl`}>
            Seven tools that share what they know.
          </h2>
          <p className="text-text-2 mt-3 max-w-2xl text-lg">
            An order shows up in Shipping, counts against Stock, and sits beside the
            customer&rsquo;s email in the Help desk. You type it once, if at all.
          </p>

          <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TOOLS.map((tool) => (
              <li
                key={tool.name}
                className="bg-card border-border flex flex-col rounded-xl border p-6"
              >
                <span className="bg-sunken text-text-2 grid size-10 place-items-center rounded-lg">
                  <tool.icon className="size-5" aria-hidden />
                </span>
                <h3 className="font-display mt-5 text-xl font-normal">{tool.name}</h3>
                <p className="text-teal-soft-ink mt-1 text-sm font-semibold">{tool.line}</p>
                <ul className="text-text-2 mt-4 flex flex-1 flex-col gap-2.5 text-sm">
                  {tool.points.map((point) => (
                    <li key={point} className="flex gap-2.5">
                      <Check className="text-mint-ink mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                <div className="border-border mt-6 flex items-center justify-between gap-4 border-t pt-4 text-sm">
                  <span className="text-muted-foreground">{tool.note}</span>
                  <Link
                    href={`/help/${tool.help}`}
                    className="flex shrink-0 items-center gap-1 font-semibold hover:underline"
                    aria-label={`How ${tool.name} works`}
                  >
                    How it works <ArrowRight className="size-4" aria-hidden />
                  </Link>
                </div>
              </li>
            ))}
            <li className="bg-teal text-on-teal flex flex-col justify-between gap-6 rounded-xl p-6 sm:col-span-2">
              <div>
                <p
                  className={`${EYEBROW} flex w-fit items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5`}
                >
                  <Sparkles className="size-3.5" aria-hidden /> And an assistant
                </p>
                <h3 className={`${DISPLAY} mt-4 text-2xl`}>
                  Claude drafts. You decide what goes out.
                </h3>
                <p className="text-on-teal-2 mt-2 max-w-xl text-sm">
                  A reply to a customer, a caption, a whole email in your colours, a first go at
                  your brand kit. Every draft lands in front of you to edit. Sending is always your
                  button to press.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <p className="bg-card text-foreground font-read max-w-sm rounded-lg px-4 py-3 text-sm">
                  <span className="text-muted-foreground block text-xs">You ask</span>
                  &ldquo;What sold best last month, and what should I reorder?&rdquo;
                </p>
                <Link
                  href="/help/assistant"
                  className="flex items-center gap-1 text-sm font-semibold underline underline-offset-4"
                >
                  What the assistant can do <ArrowRight className="size-4" aria-hidden />
                </Link>
              </div>
            </li>
          </ul>
        </section>

        <section id="how" className="bg-sunken scroll-mt-6">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
            <div className="grid gap-4 sm:grid-cols-2" aria-hidden>
              <div className="bg-teal text-on-teal flex flex-col justify-end gap-2 rounded-xl p-5 sm:row-span-2 sm:min-h-64">
                <Package className="size-5" />
                <p className="font-semibold">No spreadsheets</p>
                <p className="text-on-teal-2 text-sm">
                  Reorder dates come from what really sold, not from a tab you forgot to update.
                </p>
              </div>
              <div className="bg-card border-border rounded-xl border p-5">
                <p className={`${EYEBROW} text-muted-foreground`}>To order</p>
                <p className="mt-2 text-sm font-semibold">Merino, charcoal</p>
                <p className="text-muted-foreground text-xs">Runs out in 9 days · order 4 cases</p>
                <Badge tone="waiting" className="mt-3">
                  Order by Friday
                </Badge>
              </div>
              <div className="bg-card border-border rounded-xl border p-5">
                <p className={`${EYEBROW} text-muted-foreground`}>Label</p>
                <p className="mt-2 text-sm font-semibold">Ground · 2 days</p>
                <p className="text-muted-foreground text-xs">Customer paid $12.00</p>
                <p className="text-mint-ink mt-3 text-sm font-semibold">$3.15 left over</p>
              </div>
            </div>

            <div>
              <p className={`${EYEBROW} text-muted-foreground`}>Built for people at the bench</p>
              <h2 className={`${DISPLAY} mt-3 text-3xl sm:text-4xl`}>
                You didn&rsquo;t start a studio to spend your day in browser tabs.
              </h2>
              <p className="text-text-2 mt-4 text-lg">
                Most business software assumes a desk and a free afternoon. When your hands are
                covered in clay, sawdust or ink, you need something plain, legible at a glance, and
                forgiving.
              </p>
              <ol className="mt-8 flex flex-col gap-3">
                {STEPS.map((step, index) => (
                  <li
                    key={step.title}
                    className="bg-card border-border flex gap-4 rounded-xl border p-4"
                  >
                    <span className="bg-mint-soft text-mint-ink grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold">
                      {index + 1}
                    </span>
                    <div>
                      <p className="font-semibold">{step.title}</p>
                      <p className="text-text-2 text-sm">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <Button asChild variant="dark" size="lg" className="mt-8">
                <Link href="/help/first-steps">See your first ten minutes</Link>
              </Button>
            </div>
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-6xl scroll-mt-6 px-4 py-20 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <p className={`${EYEBROW} text-muted-foreground`}>Plain, predictable pricing</p>
            <h2 className={`${DISPLAY} mt-3 text-3xl sm:text-4xl`}>
              One monthly price. No fee per sale or per seat booked.
            </h2>
            <p className="text-text-2 mt-3 text-lg">
              Every plan starts with {TRIAL_DAYS} days free. Change or cancel whenever you like.
            </p>
          </div>
          <div className="mt-10">
            <PlanCards
              footer={() => (
                <Button asChild variant="outline" className="w-full">
                  <Link href="/login">Start free trial</Link>
                </Button>
              )}
            />
          </div>
        </section>

        <section className="px-4 pb-20 sm:px-6">
          <div className="rail-texture text-on-teal mx-auto flex max-w-5xl flex-col items-center gap-5 rounded-2xl px-6 py-16 text-center shadow-xl">
            <p className={`${EYEBROW} text-mint-soft`}>Ready for a quieter back office?</p>
            <h2 className={`${DISPLAY} max-w-2xl text-3xl sm:text-4xl`}>
              Get your studio time back. Let the software do the remembering.
            </h2>
            <p className="text-on-teal-2 max-w-xl">
              Connect your shop and see tomorrow morning&rsquo;s list today. Free for {TRIAL_DAYS}{" "}
              days.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Button asChild size="lg">
                <Link href="/login">Start your free trial</Link>
              </Button>
              <Link
                href="/help"
                className="flex h-10 items-center rounded-sm bg-white/10 px-5 text-sm font-semibold hover:bg-white/15"
              >
                Read the help pages
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
