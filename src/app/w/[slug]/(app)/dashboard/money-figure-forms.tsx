"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { toCents } from "@/lib/dashboard/lines";
import type { FigureGroup } from "@/lib/dashboard/figure-fields";
import {
  saveBudgetSettings,
  saveCutterSettings,
  saveHealthSettings,
  type MoneySettingsState,
} from "./money-settings-actions";

const SAVERS = {
  health: saveHealthSettings,
  budget: saveBudgetSettings,
  cutter: saveCutterSettings,
} as const;

type Values = Record<string, string>;

const initial = (groups: FigureGroup[], body: Record<string, unknown>): Values =>
  Object.fromEntries(
    groups
      .flatMap((group) => group.fields)
      .map((field) => {
        const value = body[field.key];
        switch (field.kind) {
          case "list":
            return [field.key, Array.isArray(value) ? value.join("\n") : ""];
          case "money":
            return [field.key, typeof value === "number" ? (value / 100).toFixed(2) : ""];
          default:
            return [field.key, typeof value === "number" ? String(value) : ""];
        }
      }),
  );

/** What the form holds, as the setting's body. Unreadable numbers go as text so the server says why. */
const bodyOf = (groups: FigureGroup[], values: Values) =>
  Object.fromEntries(
    groups
      .flatMap((group) => group.fields)
      .map((field) => {
        const raw = (values[field.key] ?? "").trim();
        switch (field.kind) {
          case "list":
            return [
              field.key,
              raw
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            ];
          case "money":
            return [field.key, raw === "" ? null : toCents(raw.replace(/[,$\s]/g, ""))];
          case "optional":
            return [field.key, raw === "" ? null : Number(raw)];
          default:
            return [field.key, raw === "" ? undefined : Number(raw)];
        }
      }),
  );

export function FigureSettingsForm({
  slug,
  setting,
  groups,
  body,
  currency,
}: {
  slug: string;
  setting: keyof typeof SAVERS;
  groups: FigureGroup[];
  body: Record<string, unknown>;
  currency: string;
}) {
  const [state, action] = useActionState<MoneySettingsState, FormData>(
    SAVERS[setting].bind(null, slug),
    {},
  );
  const [values, setValues] = useState<Values>(() => initial(groups, body));
  const [dirty, setDirty] = useState(false);
  const set = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="body" value={JSON.stringify(bodyOf(groups, values))} />
      {groups.map((group) => (
        <fieldset key={group.title} className="flex flex-col gap-4">
          <legend className="mb-1 text-sm font-semibold">{group.title}</legend>
          {group.about && <p className="text-muted-foreground -mt-2 text-sm">{group.about}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            {group.fields.map((field) => {
              const id = `${setting}-${field.key}`;
              const help = field.help ? (
                <p id={`${id}-help`} className="text-muted-foreground text-xs">
                  {field.help}
                </p>
              ) : null;
              if (field.kind === "list") {
                return (
                  <div key={field.key} className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor={id}>{field.label}</Label>
                    <textarea
                      id={id}
                      rows={4}
                      value={values[field.key]}
                      onChange={(e) => set(field.key, e.target.value)}
                      aria-describedby={field.help ? `${id}-help` : undefined}
                      className="border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2"
                      placeholder="One per line"
                    />
                    {help}
                  </div>
                );
              }
              const suffix =
                field.kind === "money" ? currency : "suffix" in field ? field.suffix : undefined;
              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>{field.label}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={id}
                      inputMode={field.kind === "money" ? "decimal" : "numeric"}
                      value={values[field.key]}
                      onChange={(e) => set(field.key, e.target.value)}
                      aria-describedby={field.help ? `${id}-help` : undefined}
                      className="w-32"
                      placeholder={field.kind === "number" ? undefined : "Not set"}
                    />
                    {suffix && <span className="text-muted-foreground text-sm">{suffix}</span>}
                  </div>
                  {help}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton
        variant={dirty ? "default" : "outline"}
        pendingText="Saving…"
        className="sm:w-fit"
      >
        Save
      </SubmitButton>
    </form>
  );
}
