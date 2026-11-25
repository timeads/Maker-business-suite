"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  AUTO_REPLY_CHANNELS,
  AUTO_REPLY_WHEN,
  MAX_AUTO_REPLY_CHARS,
  MAX_QUIET_HOURS,
  MIN_QUIET_HOURS,
  messagesNeeded,
  type AutoReplies,
  type AutoReplyChannel,
  type AutoReplyWhen,
} from "@/lib/helpdesk/auto-reply/config";
import {
  AUTO_REPLY_LABELS,
  SAMPLE_FIRST_NAME,
  WHEN_LABELS,
  dayRows,
  previewWords,
} from "@/lib/helpdesk/auto-reply/form";
import { unknownPlaceholders } from "@/lib/helpdesk/auto-reply/rules";
import type { HelpdeskState } from "@/app/w/[slug]/helpdesk/actions";
import { saveAutoReplies, sendAutoReplyTest } from "@/app/w/[slug]/helpdesk/auto-reply-actions";

const AREA =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-60";

/** One message box with the message as it will read under it. */
function MessageBox({
  id,
  name,
  label,
  hint,
  value,
  onChange,
  businessName,
  disabled,
  placeholder,
}: {
  id: string;
  name: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  businessName: string;
  disabled: boolean;
  placeholder: string;
}) {
  const unknown = unknownPlaceholders(value);
  const preview = previewWords(value, businessName);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        name={name}
        rows={4}
        maxLength={MAX_AUTO_REPLY_CHARS}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={AREA}
      />
      <p className="text-muted-foreground text-xs">{hint}</p>
      {unknown.length > 0 && (
        <p className="text-ochre-text text-xs">
          {unknown.join(", ")} isn&apos;t something we fill in, so it would be sent exactly as
          typed. Only {"{{first_name}}"} and {"{{business_name}}"} are filled in.
        </p>
      )}
      <div className="bg-sunken rounded-md px-3 py-2.5">
        <p className="text-muted-foreground text-xs font-semibold">As it will read</p>
        {preview ? (
          <p className="font-read mt-1 text-sm break-words whitespace-pre-wrap">{preview}</p>
        ) : (
          <p className="text-muted-foreground mt-1 text-sm">Nothing written yet.</p>
        )}
      </div>
    </div>
  );
}

/** Everything about automatic replies, saved together. */
export function AutoRepliesForm({
  slug,
  settings,
  businessName,
  timeZone,
  canEdit,
  ready,
}: {
  slug: string;
  settings: AutoReplies;
  businessName: string;
  timeZone: string;
  canEdit: boolean;
  /** Whether each channel can carry a reply right now, and a line to say when it can't. */
  ready: Record<AutoReplyChannel, string | null>;
}) {
  const [state, action] = useActionState<HelpdeskState, FormData>(
    saveAutoReplies.bind(null, slug),
    {},
  );
  const [channels, setChannels] = useState(() => ({
    instagram: { ...settings.instagram },
    facebook: { ...settings.facebook },
    email: { ...settings.email },
  }));
  const change = (name: AutoReplyChannel, patch: Partial<AutoReplies[AutoReplyChannel]>) =>
    setChannels((now) => ({ ...now, [name]: { ...now[name], ...patch } }));
  const usesHours = AUTO_REPLY_CHANNELS.some(
    (name) => channels[name].on && channels[name].when !== "always",
  );

  return (
    <form action={action} className="flex flex-col gap-6">
      {AUTO_REPLY_CHANNELS.map((name) => {
        const channel = channels[name];
        const needs = messagesNeeded(channel.when);
        return (
          <fieldset
            key={name}
            disabled={!canEdit}
            className="border-border flex flex-col gap-4 rounded-lg border px-4 py-4"
          >
            <legend className="px-1 text-sm font-bold">{AUTO_REPLY_LABELS[name]}</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name={`${name}_on`}
                value="1"
                checked={channel.on}
                onChange={(event) => change(name, { on: event.target.checked })}
                className="mt-0.5"
              />
              <span>
                <span className="font-semibold">
                  Send an automatic reply to {name === "email" ? "emails" : AUTO_REPLY_LABELS[name]}
                </span>
                <span className="text-muted-foreground block text-xs">
                  {name === "email"
                    ? "Off unless you tick it. Newsletters, bounces, other auto-replies and no-reply senders never get one."
                    : "Goes as a message from your account, inside the 24 hours the platform allows after someone writes."}
                </span>
              </span>
            </label>
            {channel.on && ready[name] && <p className="text-ochre-text text-xs">{ready[name]}</p>}
            <div className="flex flex-col gap-2 sm:max-w-sm">
              <Label htmlFor={`${name}-when`}>When</Label>
              <Select
                id={`${name}-when`}
                name={`${name}_when`}
                value={channel.when}
                onChange={(event) => change(name, { when: event.target.value as AutoReplyWhen })}
              >
                {AUTO_REPLY_WHEN.map((when) => (
                  <option key={when} value={when}>
                    {WHEN_LABELS[when]}
                  </option>
                ))}
              </Select>
            </div>
            {/* Both boxes are always sent with the form, so switching "when" never loses words. */}
            <div className={needs.message ? "" : "hidden"}>
              <MessageBox
                id={`${name}-message`}
                name={`${name}_message`}
                label={channel.when === "both" ? "Message while you are open" : "Message"}
                hint="Plain words. {{first_name}} becomes the person's first name when we know it (“there” when we don't) and {{business_name}} becomes your workspace's name."
                value={channel.message}
                onChange={(message) => change(name, { message })}
                businessName={businessName}
                disabled={!canEdit}
                placeholder={
                  "Hi {{first_name}}, thanks for your message! This is an automatic reply to say it reached us. One of us will answer as soon as we can."
                }
              />
            </div>
            <div className={needs.away ? "" : "hidden"}>
              <MessageBox
                id={`${name}-away`}
                name={`${name}_away`}
                label="Away message, outside opening hours"
                hint="Sent when someone writes while you are closed, by the hours below."
                value={channel.away_message}
                onChange={(away_message) => change(name, { away_message })}
                businessName={businessName}
                disabled={!canEdit}
                placeholder={
                  "Hi {{first_name}}, thanks for writing to {{business_name}}. This is an automatic reply: we're closed just now and will answer when we're back."
                }
              />
            </div>
          </fieldset>
        );
      })}

      <fieldset
        disabled={!canEdit}
        className="border-border flex flex-col gap-3 rounded-lg border px-4 py-4"
      >
        <legend className="px-1 text-sm font-bold">Opening hours</legend>
        <p className="text-muted-foreground text-xs">
          On your workspace&apos;s clocks ({timeZone.replace(/_/g, " ")}), daylight saving included.
          {usesHours
            ? " A message counts as inside or outside hours by when the person wrote it."
            : " Only used by “Only outside opening hours” and “One message when open, another when closed”."}
        </p>
        <ul className="flex flex-col gap-2">
          {dayRows(settings.hours).map((day) => (
            <li key={day.weekday} className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex w-32 items-center gap-2">
                <input
                  type="checkbox"
                  name={`day_${day.weekday}_open`}
                  value="1"
                  defaultChecked={day.open}
                />
                {day.name}
              </label>
              <Label htmlFor={`day-${day.weekday}-start`} className="sr-only">
                {day.name} opens
              </Label>
              <Input
                id={`day-${day.weekday}-start`}
                type="time"
                name={`day_${day.weekday}_start`}
                defaultValue={day.start}
                className="w-32"
              />
              <span className="text-muted-foreground">to</span>
              <Label htmlFor={`day-${day.weekday}-end`} className="sr-only">
                {day.name} closes
              </Label>
              <Input
                id={`day-${day.weekday}-end`}
                type="time"
                name={`day_${day.weekday}_end`}
                defaultValue={day.end}
                className="w-32"
              />
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          Untick a day you are closed. A closing time of 11:59 pm means open until midnight.
        </p>
      </fieldset>

      <fieldset
        disabled={!canEdit}
        className="border-border flex flex-col gap-2 rounded-lg border px-4 py-4"
      >
        <legend className="px-1 text-sm font-bold">Not too often</legend>
        <Label htmlFor="quiet-hours">
          At most one automatic reply per person, per channel, every
        </Label>
        <div className="flex items-center gap-2 text-sm">
          <Input
            id="quiet-hours"
            type="number"
            name="quiet_hours"
            min={MIN_QUIET_HOURS}
            max={MAX_QUIET_HOURS}
            step={1}
            defaultValue={settings.quiet_hours}
            className="w-24"
          />
          hours
        </div>
        <p className="text-muted-foreground text-xs">
          So someone who sends three messages in a row gets one reply, not three. And once one of
          you has answered, nothing automatic follows.
        </p>
      </fieldset>

      {canEdit ? (
        <div className="flex flex-col gap-2">
          <FormMessage>{state.error}</FormMessage>
          <FormMessage kind="success">{state.message}</FormMessage>
          <SubmitButton pendingText="Saving…" className="w-fit">
            Save automatic replies
          </SubmitButton>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">Owners and admins change automatic replies.</p>
      )}
      <p className="text-muted-foreground text-xs">
        The preview greets a made-up customer called {SAMPLE_FIRST_NAME}.
      </p>
    </form>
  );
}

/** Emails the saved email reply to the person pressing the button, and nobody else. */
export function SendTestForm({
  slug,
  email,
  hasAway,
}: {
  slug: string;
  email: string;
  /** The saved email setting uses an away message, so that one can be tested too. */
  hasAway: boolean;
}) {
  const [state, action] = useActionState<HelpdeskState, FormData>(
    sendAutoReplyTest.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          variant="outline"
          name="which"
          value="usual"
          pendingText="Sending…"
          className="w-fit"
        >
          Send me a test
        </SubmitButton>
        {hasAway && (
          <SubmitButton
            variant="outline"
            name="which"
            value="away"
            pendingText="Sending…"
            className="w-fit"
          >
            Send me the away message
          </SubmitButton>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Goes only to {email}, with the words as they are saved now. Save first if you have just
        changed them.
      </p>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}
