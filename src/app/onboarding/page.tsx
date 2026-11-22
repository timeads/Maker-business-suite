import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { currencyOptions, timezoneOptions } from "@/lib/locale-options";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Set up your workspace" };

export default async function OnboardingPage() {
  const user = await requireUser("/onboarding");
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-4 py-12">
      <p className="text-ochre-text text-sm font-medium">Maker Business Suite</p>
      <Card>
        <CardHeader>
          <CardTitle>Let&apos;s set up your workspace</CardTitle>
          <CardDescription>
            A workspace is your business&apos;s home here. You can change any of this later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OnboardingForm timezones={timezoneOptions()} currencies={currencyOptions()} />
        </CardContent>
      </Card>
      <form action="/auth/signout" method="post" className="text-muted-foreground text-sm">
        Signed in as {user.email}.{" "}
        <button type="submit" className="hover:text-foreground underline underline-offset-4">
          Sign out
        </button>
      </form>
    </main>
  );
}
