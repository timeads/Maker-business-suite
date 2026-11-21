import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getUser } from "@/lib/auth";
import { safeNextPath } from "@/lib/safe-redirect";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  link: "That sign-in link has expired or was already used. Enter your email for a fresh one.",
  google: "Google sign-in didn't go through. Try again, or use an email link instead.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  if (await getUser()) redirect(next);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <Link href="/" className="text-primary text-sm font-medium">
        Maker Business Suite
      </Link>
      <Card>
        <CardHeader>
          <CardTitle>Welcome</CardTitle>
          <CardDescription>
            Sign in or start a new account — it&apos;s the same step. No password to remember.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm next={next} initialError={params.error ? ERRORS[params.error] : undefined} />
        </CardContent>
      </Card>
    </main>
  );
}
