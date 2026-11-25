"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { HelpCentreConfig } from "@/lib/helpdesk/help-centre/config";
import { saveHelpCentreSettings } from "../../../helpdesk/manual/help-actions";

const area =
  "border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";
const hint = "text-muted-foreground font-read text-xs";
const group = "flex flex-col gap-3 border-border border-t pt-5 first:border-t-0 first:pt-0";
const legend = "text-sm font-bold";

export function HelpCentreSettingsForm({
  slug,
  config,
  workspaceName,
  ownAddress,
}: {
  slug: string;
  config: HelpCentreConfig;
  workspaceName: string;
  /** The workspace's own support address, used when no other is typed. */
  ownAddress: string | null;
}) {
  const [state, action] = useActionState(saveHelpCentreSettings.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-5">
      <fieldset className={group}>
        <legend className={legend}>Who can see it</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="on"
            value="1"
            defaultChecked={config.on}
            className="mt-0.5"
          />
          <span>
            Help centre on
            <span className={`${hint} block`}>
              While this is off, every page of it says “not found”, whatever is published.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="noindex"
            value="1"
            defaultChecked={config.noindex}
            className="mt-0.5"
          />
          <span>
            Ask search engines to leave it out
            <span className={`${hint} block`}>
              People with the link can still read it. Handy while you are still writing.
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset className={group}>
        <legend className={legend}>What it says at the top</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hc-title">Title</Label>
          <Input
            id="hc-title"
            name="title"
            maxLength={60}
            defaultValue={config.title}
            placeholder={`${workspaceName} help`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hc-intro">A line under it</Label>
          <Input
            id="hc-intro"
            name="intro"
            maxLength={200}
            defaultValue={config.intro}
            placeholder="Answers to the questions we hear most."
          />
        </div>
        <p className={hint}>
          Your logo is the picture tagged “logo” in Social → Assets, if you have one.
        </p>
      </fieldset>

      <fieldset className={group}>
        <legend className={legend}>Categories</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hc-categories">One on each line, in the order they should appear</Label>
          <textarea
            id="hc-categories"
            name="categories"
            rows={5}
            defaultValue={config.categories.map((c) => c.label).join("\n")}
            placeholder={"Getting started\nOrders & delivery\nCare & repairs"}
            className={area}
          />
          <p className={hint}>
            Up to twelve. Rewording a line in place keeps its articles; an article with no category
            is listed after the others.
          </p>
        </div>
      </fieldset>

      <fieldset className={group}>
        <legend className={legend}>Contact us</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hc-contact-line">What it says</Label>
          <Input
            id="hc-contact-line"
            name="contact_line"
            maxLength={160}
            defaultValue={config.contact_line}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hc-contact-email">Where customers write</Label>
          <Input
            id="hc-contact-email"
            name="contact_email"
            type="email"
            maxLength={120}
            defaultValue={config.contact_email}
            placeholder={ownAddress ?? "hello@yourshop.com"}
          />
          <p className={hint}>
            {ownAddress
              ? `Left empty, it shows your help desk's address (${ownAddress}).`
              : "Left empty, no address is shown."}
          </p>
        </div>
      </fieldset>

      {state.error && <FormMessage>{state.error}</FormMessage>}
      {state.message && <FormMessage kind="success">{state.message}</FormMessage>}
      <div>
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
      </div>
    </form>
  );
}
