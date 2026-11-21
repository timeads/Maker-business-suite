"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { disconnectConnection, startConnection, syncNow, type ConnectionState } from "./actions";

type Field = { name: string; label: string; placeholder: string; help?: string };

export function ConnectForm({
  slug,
  provider,
  providerName,
  fields,
  label,
}: {
  slug: string;
  provider: string;
  providerName: string;
  fields: Field[];
  label: string;
}) {
  const [state, action] = useActionState<ConnectionState, FormData>(
    startConnection.bind(null, slug, provider),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      {fields.map((field) => (
        <div key={field.name} className="flex flex-col gap-2">
          <Label htmlFor={`${provider}-${field.name}`}>{field.label}</Label>
          <Input
            id={`${provider}-${field.name}`}
            name={field.name}
            placeholder={field.placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          {field.help && <p className="text-muted-foreground text-xs">{field.help}</p>}
        </div>
      ))}
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton pendingText={`Opening ${providerName}…`} className="sm:w-fit">
        {label}
      </SubmitButton>
    </form>
  );
}

export function ConnectionActions({
  slug,
  provider,
  providerName,
  canSync,
}: {
  slug: string;
  provider: string;
  providerName: string;
  canSync: boolean;
}) {
  const [syncState, syncAction] = useActionState<ConnectionState, FormData>(
    syncNow.bind(null, slug, provider),
    {},
  );
  const [disconnectState, disconnectAction] = useActionState<ConnectionState, FormData>(
    disconnectConnection.bind(null, slug, provider),
    {},
  );
  const message = syncState.message ?? disconnectState.message;
  const error = syncState.error ?? disconnectState.error;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {canSync && (
          <form action={syncAction}>
            <SubmitButton variant="outline" size="sm" pendingText="Starting…">
              Sync now
            </SubmitButton>
          </form>
        )}
        <form
          action={disconnectAction}
          onSubmit={(event) => {
            if (!window.confirm(`Disconnect ${providerName}? Its data will stop updating.`)) {
              event.preventDefault();
            }
          }}
        >
          <SubmitButton variant="ghost" size="sm" pendingText="Disconnecting…">
            Disconnect
          </SubmitButton>
        </form>
      </div>
      <FormMessage>{error}</FormMessage>
      {message && <FormMessage kind="success">{message}</FormMessage>}
    </div>
  );
}
