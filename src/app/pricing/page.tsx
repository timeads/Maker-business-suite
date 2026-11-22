import type { Metadata } from "next";
import Link from "next/link";
import { PlanCards } from "@/components/plan-cards";
import { Button } from "@/components/ui/button";
import { RETENTION_DAYS, TRIAL_DAYS } from "@/lib/billing/plans";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Simple monthly plans for small maker businesses. Start with a free trial.",
};

export default function PricingPage() {
  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-16">
      <div className="flex flex-col gap-3">
        <Link href="/" className="text-ochre-text text-sm font-medium">
          Maker Business Suite
        </Link>
        <h1 className="text-4xl font-semibold tracking-tight text-balance">
          One price for the whole back office.
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg">
          Every plan starts with {TRIAL_DAYS} days free. Change or cancel whenever you like; if you
          leave, we keep your data for {RETENTION_DAYS} days in case you change your mind.
        </p>
      </div>
      <PlanCards
        footer={(plan) => (
          <Button
            asChild
            variant={plan.key === "growth" ? "default" : "outline"}
            className="w-full"
          >
            <Link href="/login">Start free trial</Link>
          </Button>
        )}
      />
    </main>
  );
}
