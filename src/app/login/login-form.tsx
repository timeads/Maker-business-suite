"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { signInWithEmail, signInWithGoogle, type LoginState } from "./actions";

export function LoginForm({ next, initialError }: { next: string; initialError?: string }) {
  const [state, emailAction] = useActionState<LoginState, FormData>(signInWithEmail, {
    error: initialError,
  });

  if (state.sentTo) {
    return (
      <div className="flex flex-col gap-2" role="status">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="text-muted-foreground text-sm">
          We sent a sign-in link to{" "}
          <span className="text-foreground font-medium">{state.sentTo}</span>. Open it on this
          device and you&apos;re in. It can take a minute to arrive.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <form action={emailAction} className="flex flex-col gap-3">
        <input type="hidden" name="next" value={next} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@yourstudio.com"
            required
          />
        </div>
        <FormMessage>{state.error}</FormMessage>
        <SubmitButton pendingText="Sending…">Email me a sign-in link</SubmitButton>
      </form>

      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>

      <form action={signInWithGoogle}>
        <input type="hidden" name="next" value={next} />
        <Button type="submit" variant="outline" className="w-full">
          Continue with Google
        </Button>
      </form>
    </div>
  );
}
