"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { TEXT_INFO, TEXT_KINDS, type TextKind, type TextSettings } from "@/lib/texts/config";
import { COUNTRIES, COUNTRY_KEYS } from "@/lib/texts/phone";
import { lengthWords, textLength } from "@/lib/texts/segments";
import {
  DEFAULT_TEXTS,
  TEXT_FILL_INS,
  textFor,
  textTemplate,
  unknownTextFillIns,
  type sampleBooking,
} from "@/lib/texts/words";
import { saveTextSettings, sendTestText } from "./text-actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring font-read w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";

type Sample = ReturnType<typeof sampleBooking>;

/** One message: its tick, its words, and what it will look like with the count. */
function MessageWords({
  kind,
  settings,
  sample,
  optOut,
}: {
  kind: TextKind;
  settings: TextSettings;
  sample: Sample;
  optOut: string;
}) {
  const [body, setBody] = useState(textTemplate(kind, settings));
  const unknown = unknownTextFillIns(body);
  const preview = textFor(kind, sample, {
    ...settings,
    opt_out_line: optOut || settings.opt_out_line,
    messages: { ...settings.messages, [kind]: { on: true, body } },
  });
  const length = textLength(preview);
  return (
    <fieldset className="border-border flex flex-col gap-2 rounded-md border p-3">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" name={`${kind}_on`} defaultChecked={settings.messages[kind].on} />
        {TEXT_INFO[kind].name}
      </label>
      <p className="text-muted-foreground text-xs">{TEXT_INFO[kind].when}</p>
      <textarea
        name={`${kind}_body`}
        rows={3}
        maxLength={600}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className={textarea}
        aria-label={`${TEXT_INFO[kind].name} words`}
      />
      {body.trim() !== DEFAULT_TEXTS[kind] && (
        <button
          type="button"
          className="text-muted-foreground w-fit text-xs underline"
          onClick={() => setBody(DEFAULT_TEXTS[kind])}
        >
          Go back to our words
        </button>
      )}
      {unknown.length > 0 && (
        <FormMessage>We don&apos;t have these fill-ins: {unknown.join(", ")}</FormMessage>
      )}
      <div className="bg-sunken rounded-md p-2 text-sm">
        <p className="font-read">{preview}</p>
        <p
          className={`mt-1 text-xs ${length.segments > 2 ? "text-brick" : "text-muted-foreground"}`}
        >
          {lengthWords(length)}
        </p>
      </div>
    </fieldset>
  );
}

export function TextsForm({
  slug,
  settings,
  sample,
}: {
  slug: string;
  settings: TextSettings;
  /** A made-up booking for the previews, worked out on the server. */
  sample: Sample;
}) {
  const [state, action] = useActionState(saveTextSettings.bind(null, slug), {});
  const [optOut, setOptOut] = useState(settings.opt_out_line);
  return (
    <form action={action} className="flex flex-col gap-5">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" name="on" defaultChecked={settings.on} />
        Send text reminders to people who ask for them
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="texts-country">Numbers without a country code are in</Label>
          <Select id="texts-country" name="default_country" defaultValue={settings.default_country}>
            {COUNTRY_KEYS.map((key) => (
              <option key={key} value={key}>
                {COUNTRIES[key].name}
              </option>
            ))}
          </Select>
          <p className="text-muted-foreground text-xs">
            A number we can&apos;t read for sure gets no texts, rather than a guess.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="texts-optout">Added to the end of every text</Label>
          <Input
            id="texts-optout"
            name="opt_out_line"
            value={optOut}
            onChange={(event) => setOptOut(event.target.value)}
            maxLength={80}
          />
          <p className="text-muted-foreground text-xs">
            It must tell people to reply STOP. Left off a text that already says STOP.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="texts-consent">Beside the tick box when people book</Label>
        <textarea
          id="texts-consent"
          name="consent_words"
          rows={2}
          maxLength={300}
          defaultValue={settings.consent_words}
          className={textarea}
        />
        <p className="text-muted-foreground text-xs">
          Shown in the date picker on your shop and on your booking page, with a box for a mobile
          number. Nobody gets a text unless they tick it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="texts-reminder">Reminder, hours before</Label>
          <Input
            id="texts-reminder"
            name="reminder_hours"
            type="number"
            min={1}
            max={336}
            defaultValue={settings.reminder_hours}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="texts-dayof">Day-of reminder, hours before</Label>
          <Input
            id="texts-dayof"
            name="day_of_hours"
            type="number"
            min={1}
            max={24}
            defaultValue={settings.day_of_hours}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="texts-followup">Thank-you, hours after</Label>
          <Input
            id="texts-followup"
            name="followup_hours"
            type="number"
            min={1}
            max={168}
            defaultValue={settings.followup_hours}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Which texts go, and what they say</h3>
        <p className="text-muted-foreground text-xs">
          Fill-ins: {TEXT_FILL_INS.map((fill) => `{{${fill.name}}}`).join(" ")}. Texts are charged
          by Twilio per part, so the count shows how many parts each one takes.
        </p>
        {TEXT_KINDS.map((kind) => (
          <MessageWords
            key={kind}
            kind={kind}
            settings={settings}
            sample={sample}
            optOut={optOut}
          />
        ))}
      </div>

      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

/** Sends one test text to the person's own number. */
export function TestTextForm({ slug }: { slug: string }) {
  const [state, action] = useActionState(sendTestText.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="test-phone">Your mobile number</Label>
          <Input id="test-phone" name="phone" type="tel" autoComplete="tel" maxLength={40} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="test-kind">Which text</Label>
          <Select id="test-kind" name="kind" defaultValue="reminder">
            {TEXT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TEXT_INFO[kind].name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="own_number" />
        This is my own number
      </label>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Sending…" className="sm:w-fit">
        Send me a test text
      </SubmitButton>
    </form>
  );
}
