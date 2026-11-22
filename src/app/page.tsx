import Link from "next/link";
import { Button } from "@/components/ui/button";
import { MODULES } from "@/lib/modules";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-10 px-4 py-16">
      <div className="flex flex-col gap-4">
        <p className="text-ochre-text text-sm font-medium">Maker Business Suite</p>
        <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
          The back office for people who make things.
        </h1>
        <p className="text-muted-foreground max-w-xl text-lg">
          See your money, answer your customers, fill your workshops and plan your posts — connected
          to the tools you already use, with nothing to install.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button asChild size="lg">
            <Link href="/login">Get started</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="lg" variant="ghost">
            <Link href="/pricing">Pricing</Link>
          </Button>
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {MODULES.map((m) => (
          <li key={m.key} className="border-border bg-card rounded-xl border p-4">
            <p className="font-medium">{m.name}</p>
            <p className="text-muted-foreground text-sm">{m.blurb}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
