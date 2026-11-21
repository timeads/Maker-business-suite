import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">We couldn&apos;t find that page</h1>
      <p className="text-muted-foreground">
        It may have moved, or you may not have access to it with this account.
      </p>
      <Button asChild className="w-fit">
        <Link href="/app">Go to your workspaces</Link>
      </Button>
    </main>
  );
}
