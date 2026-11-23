"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { disconnectConnection, startConnection, syncNow, type ConnectionState } from "./actions";

type Field = {
  name: string;
  label: string;
  placeholder: string;
  help?: string;
  secret?: boolean;
  options?: { value: string; label: string }[];
};

export function ConnectForm({
  slug,
  provider,
  providerName,
  fields,
  label,
  withKey = false,
}: {
  slug: string;
  provider: string;
  providerName: string;
  fields: Field[];
  label: string;
  /** Connects by checking a pasted key, without leaving this page. */
  withKey?: boolean;
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
          {field.options ? (
            <Select
              id={`${provider}-${field.name}`}
              name={field.name}
              defaultValue={field.options[0]?.value}
            >
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id={`${provider}-${field.name}`}
              name={field.name}
              type={field.secret ? "password" : "text"}
              placeholder={field.placeholder}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          )}
          {field.help && <p className="text-muted-foreground text-xs">{field.help}</p>}
        </div>
      ))}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton
        pendingText={
          withKey
            ? fields.length > 1
              ? "Checking your keys…"
              : "Checking your key…"
            : `Opening ${providerName}…`
        }
        className="sm:w-fit"
      >
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
  disconnectNote = "Its data will stop updating.",
}: {
  slug: string;
  provider: string;
  providerName: string;
  canSync: boolean;
  /** What disconnecting means, for the "are you sure?" question. */
  disconnectNote?: string;
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
            if (!window.confirm(`Disconnect ${providerName}? ${disconnectNote}`)) {
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
