import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Top bar and footer for the pages anyone can read: home, pricing, help. */
export function SiteHeader({ tone = "light" }: { tone?: "light" | "teal" }) {
  const onTeal = tone === "teal";
  const link = onTeal
    ? "text-on-teal-2 hover:text-on-teal rounded-sm px-2 py-1.5 text-sm font-medium"
    : "text-text-2 hover:text-foreground rounded-sm px-2 py-1.5 text-sm font-medium";
  return (
    <header className={onTeal ? "text-on-teal" : "border-border bg-card text-foreground border-b"}>
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:px-6">
        <Link href="/" className="font-display mr-auto text-xl leading-none">
          Maker Business Suite
        </Link>
        <nav aria-label="Site" className="flex items-center gap-1">
          <Link href="/pricing" className={link}>
            Pricing
          </Link>
          <Link href="/help" className={link}>
            Help
          </Link>
          <Button asChild size="sm" variant={onTeal ? "outline" : "dark"} className="ml-1">
            <Link href="/login">Sign in</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-border border-t">
      <div className="text-muted-foreground mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-6 text-sm sm:px-6">
        <p className="mr-auto">Maker Business Suite · made for people who make things</p>
        <Link href="/pricing" className="hover:text-foreground">
          Pricing
        </Link>
        <Link href="/help" className="hover:text-foreground">
          Help
        </Link>
        <Link href="/privacy" className="hover:text-foreground">
          Privacy
        </Link>
        <Link href="/terms" className="hover:text-foreground">
          Terms
        </Link>
        <Link href="/login" className="hover:text-foreground">
          Sign in
        </Link>
      </div>
    </footer>
  );
}
