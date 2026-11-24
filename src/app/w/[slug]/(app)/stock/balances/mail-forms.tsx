"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  MAIL_KINDS,
  MAX_BANK_SOURCES,
  MAX_SUPPLIER_SOURCES,
  newSourceId,
  type BankSource,
  type EmailSources,
  type SupplierSource,
} from "@/lib/stock/mail/config";
import {
  assignPendingMail,
  discardPendingMail,
  makeBillsAddress,
  readMailNow,
  removeBillsAddress,
  saveEmailSources,
  settleReview,
  tryMailSource,
  uploadBill,
  type MailState,
} from "./mail-actions";

type SupplierOption = { id: string; name: string };

/** What a read left out, as a short list. */
export function SkippedList({ skipped }: { skipped?: { what: string; reason: string }[] }) {
  if (!skipped || skipped.length === 0) return null;
  return (
    <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
      {skipped.map((s, i) => (
        <li key={`${s.what}-${i}`}>
          <span className="font-read text-text-2">{s.what}</span>: {s.reason}
        </li>
      ))}
    </ul>
  );
}

function Outcome({ state }: { state: MailState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      {state.lines && state.lines.length > 0 && (
        <ul className="font-read flex flex-col gap-0.5 text-sm">
          {state.lines.map((line, i) => (
            <li key={`${line}-${i}`}>{line}</li>
          ))}
        </ul>
      )}
      {state.skipped && state.skipped.length > 0 && (
        <div>
          <p className="text-muted-foreground text-xs font-semibold">Left out</p>
          <SkippedList skipped={state.skipped} />
        </div>
      )}
    </>
  );
}

/** "Read now": asks for a look at Gmail outside the day's own. */
export function ReadNowButton({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<MailState>({});
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => start(async () => setState(await readMailNow(slug)))}
      >
        {pending ? "Asking…" : "Read now"}
      </Button>
      {(state.error || state.message) && (
        <span
          role={state.error ? "alert" : "status"}
          className={
            state.error
              ? "text-brick max-w-64 text-right text-xs"
              : "text-muted-foreground max-w-64 text-right text-xs"
          }
        >
          {state.error ?? state.message}
        </span>
      )}
    </span>
  );
}

/** "Looks right": an entry marked to check has been checked. */
export function SettleButton({
  slug,
  entryId,
  what,
}: {
  slug: string;
  entryId: string;
  what: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <span className="flex flex-col items-end gap-0.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`${what} looks right`}
        onClick={() => start(async () => setError((await settleReview(slug, entryId)).error))}
      >
        {pending ? "Saving…" : "Looks right"}
      </Button>
      {error && (
        <span role="alert" className="text-brick text-xs">
          {error}
        </span>
      )}
    </span>
  );
}

/** A message nobody could place: pick whose it is, or put it away. */
export function AssignPendingForm({
  slug,
  pendingId,
  suppliers,
}: {
  slug: string;
  pendingId: string;
  suppliers: SupplierOption[];
}) {
  const [state, action] = useActionState(assignPendingMail.bind(null, slug, pendingId), {});
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <div className="flex flex-col gap-1.5">
      <form action={action} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`whose-${pendingId}`} className="text-xs">
            Whose is it?
          </Label>
          <Select id={`whose-${pendingId}`} name="supplier" defaultValue="" required>
            <option value="" disabled>
              Pick a supplier
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <SubmitButton variant="outline" size="sm" pendingText="Filing…">
          File it
        </SubmitButton>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (!window.confirm("Put this message away without filing anything from it?")) return;
            start(async () => setError((await discardPendingMail(slug, pendingId)).error));
          }}
        >
          {pending ? "Putting away…" : "Put away"}
        </Button>
      </form>
      <FormMessage>{state.error ?? error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SkippedList skipped={state.skipped} />
    </div>
  );
}

/** Upload an invoice or statement for this supplier. Read once, never kept. */
export function UploadBillForm({ slug, supplierId }: { slug: string; supplierId: string }) {
  const [state, action] = useActionState(uploadBill.bind(null, slug, supplierId), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bill-file">An invoice or statement (PDF, PNG or JPEG, up to 5 MB)</Label>
          <Input
            id="bill-file"
            name="file"
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            required
          />
        </div>
        <SubmitButton variant="outline" pendingText="Reading…">
          Read it and file it
        </SubmitButton>
      </div>
      <p className="text-muted-foreground text-xs">
        Claude reads the file once and files what it finds on this account, marked “to check” if
        anything was unclear. The file itself isn&apos;t kept.
      </p>
      <Outcome state={state} />
    </form>
  );
}

/** The bills address, with a copy button, a new address and the off switch. */
export function BillsAddressBox({ slug, address }: { slug: string; address: string | null }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<MailState>({});
  const [copied, setCopied] = useState(false);
  const run = (action: (slug: string) => Promise<MailState>) =>
    start(async () => setState(await action(slug)));
  if (!address) {
    return (
      <div className="flex flex-col items-start gap-2">
        <Button type="button" disabled={pending} onClick={() => run(makeBillsAddress)}>
          {pending ? "Making it…" : "Switch on and get my address"}
        </Button>
        <FormMessage>{state.error}</FormMessage>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="bg-panel border-border rounded-sm border px-2 py-1.5 font-mono text-[13px] break-all select-all">
          {address}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (
              !window.confirm(
                "Make a new address? The one you have now stops working straight away, so anything still forwarding to it won't be read.",
              )
            ) {
              return;
            }
            run(makeBillsAddress);
          }}
        >
          Make a new address
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (!window.confirm("Switch Bills by email off? The address stops working.")) return;
            run(removeBillsAddress);
          }}
        >
          Switch off
        </Button>
      </div>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </div>
  );
}

/** "Try it": what would be filed from one saved source's latest mail. Files nothing. */
function TryButton({ slug, sourceId }: { slug: string; sourceId: string }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<MailState>({});
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={pending}
        onClick={() => start(async () => setState(await tryMailSource(slug, sourceId)))}
      >
        {pending ? "Looking…" : "Try it"}
      </Button>
      <Outcome state={state} />
    </div>
  );
}

const KIND_WORDS: Record<(typeof MAIL_KINDS)[number], string> = {
  mixed: "A mix — let the reader decide",
  invoice: "Invoices",
  statement: "Statements (and payments they list)",
  payment: "Notes that they received a payment",
};

const list = (text: string) =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

const box = "border-border flex flex-col gap-3 rounded-lg border p-3";

/**
 * Who to recognise: each supplier's sender, and the bank's payment notices.
 * The whole list is saved at once, as the workspace's `email_sources`.
 */
export function SourcesEditor({
  slug,
  initial,
  suppliers,
  canTry,
  showGmail,
}: {
  slug: string;
  initial: EmailSources;
  suppliers: SupplierOption[];
  /** Gmail can be read right now, so "Try it" has something to look in. */
  canTry: boolean;
  /** Offer the Gmail-only settings (the switch, the hour, labels). */
  showGmail: boolean;
}) {
  const [config, setConfig] = useState<EmailSources>(initial);
  const [saved, setSaved] = useState<EmailSources>(initial);
  const [state, action] = useActionState(async (prev: MailState, formData: FormData) => {
    const result = await saveEmailSources(slug, prev, formData);
    if (!result.error) setSaved(config);
    return result;
  }, {});
  const dirty = JSON.stringify(config) !== JSON.stringify(saved);
  const first = suppliers[0]?.id ?? "";

  const setSource = (index: number, patch: Partial<SupplierSource>) =>
    setConfig((c) => ({
      ...c,
      suppliers: c.suppliers.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  const setBank = (index: number, patch: Partial<BankSource>) =>
    setConfig((c) => ({
      ...c,
      bank: c.bank.map((b, i) => (i === index ? { ...b, ...patch } : b)),
    }));

  if (suppliers.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Add your suppliers first (Stock → Suppliers), then say here who their bills come from.
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="body" value={JSON.stringify(config)} />

      <div className="flex flex-col gap-3">
        <h3 className="font-semibold">Suppliers</h3>
        {config.suppliers.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No senders yet. Add one for each address a supplier sends bills from.
          </p>
        )}
        {config.suppliers.map((source, index) => (
          <div key={source.id} className={box}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`s-sup-${source.id}`}>Supplier</Label>
                <Select
                  id={`s-sup-${source.id}`}
                  value={source.supplier_id}
                  onChange={(e) => setSource(index, { supplier_id: e.target.value })}
                >
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`s-from-${source.id}`}>Their mail comes from</Label>
                <Input
                  id={`s-from-${source.id}`}
                  value={source.from}
                  placeholder="billing@supplier.com or supplier.com"
                  maxLength={200}
                  autoComplete="off"
                  onChange={(e) => setSource(index, { from: e.target.value.trim().toLowerCase() })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`s-kind-${source.id}`}>What it is</Label>
                <Select
                  id={`s-kind-${source.id}`}
                  value={source.kind}
                  onChange={(e) =>
                    setSource(index, { kind: e.target.value as SupplierSource["kind"] })
                  }
                >
                  {MAIL_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_WORDS[kind]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`s-reads-${source.id}`}>Where the figures are</Label>
                <Select
                  id={`s-reads-${source.id}`}
                  value={source.reads}
                  onChange={(e) =>
                    setSource(index, { reads: e.target.value as SupplierSource["reads"] })
                  }
                >
                  <option value="both">In the message or its files</option>
                  <option value="attachments">Only in attached files</option>
                  <option value="message">Only in the message itself</option>
                </Select>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`s-subj-${source.id}`}>Only when the subject has (optional)</Label>
                <Input
                  id={`s-subj-${source.id}`}
                  defaultValue={source.subject_words.join(", ")}
                  placeholder="invoice, statement"
                  onChange={(e) => setSource(index, { subject_words: list(e.target.value) })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`s-skip-${source.id}`}>Never read files named (optional)</Label>
                <Input
                  id={`s-skip-${source.id}`}
                  defaultValue={source.skip_file_words.join(", ")}
                  placeholder="waybill, packing, estimate"
                  onChange={(e) => setSource(index, { skip_file_words: list(e.target.value) })}
                />
              </div>
              {showGmail && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`s-label-${source.id}`}>Gmail label (optional)</Label>
                  <Input
                    id={`s-label-${source.id}`}
                    value={source.label}
                    maxLength={80}
                    placeholder="Suppliers"
                    onChange={(e) => setSource(index, { label: e.target.value })}
                  />
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={source.always_check}
                onChange={(e) => setSource(index, { always_check: e.target.checked })}
              />
              Mark everything from this sender “to check” (for scans and hard-to-read bills)
            </label>
            <div className="flex flex-wrap items-start justify-between gap-2">
              {canTry && saved.suppliers.some((s) => s.id === source.id) && !dirty ? (
                <TryButton slug={slug} sourceId={source.id} />
              ) : (
                <span className="text-muted-foreground text-xs">
                  {canTry ? "Save to try it against your Gmail." : ""}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setConfig((c) => ({ ...c, suppliers: c.suppliers.filter((_, i) => i !== index) }))
                }
              >
                Remove
              </Button>
            </div>
          </div>
        ))}
        {config.suppliers.length < MAX_SUPPLIER_SOURCES && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              setConfig((c) => ({
                ...c,
                suppliers: [
                  ...c.suppliers,
                  {
                    id: newSourceId(),
                    supplier_id: first,
                    from: "",
                    label: "",
                    subject_words: [],
                    kind: "mixed",
                    reads: "both",
                    skip_file_words: [],
                    always_check: false,
                  },
                ],
              }))
            }
          >
            + Add a sender
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="font-semibold">Your bank&apos;s payment notices</h3>
          <p className="text-muted-foreground text-xs">
            If your bank emails you when a payment or transfer goes out, a notice can be filed as a
            payment. Say which supplier a notice is for by words it always carries: their name as
            the bank writes it, or the end of their account number. A notice that matches none of
            them is never read.
          </p>
        </div>
        {config.bank.map((bank, index) => (
          <div key={bank.id} className={box}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`b-from-${bank.id}`}>The notices come from</Label>
                <Input
                  id={`b-from-${bank.id}`}
                  value={bank.from}
                  placeholder="alerts@yourbank.com"
                  maxLength={200}
                  autoComplete="off"
                  onChange={(e) => setBank(index, { from: e.target.value.trim().toLowerCase() })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`b-subj-${bank.id}`}>Only when the subject has (optional)</Label>
                <Input
                  id={`b-subj-${bank.id}`}
                  defaultValue={bank.subject_words.join(", ")}
                  placeholder="wire transfer"
                  onChange={(e) => setBank(index, { subject_words: list(e.target.value) })}
                />
              </div>
            </div>
            {bank.payees.map((payee, p) => {
              const setPayee = (patch: Partial<BankSource["payees"][number]>) =>
                setBank(index, {
                  payees: bank.payees.map((x, i) => (i === p ? { ...x, ...patch } : x)),
                });
              return (
                <div key={`${bank.id}-${p}`} className="grid items-end gap-3 sm:grid-cols-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`b-sup-${bank.id}-${p}`}>A payment to</Label>
                    <Select
                      id={`b-sup-${bank.id}-${p}`}
                      value={payee.supplier_id}
                      onChange={(e) => setPayee({ supplier_id: e.target.value })}
                    >
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <Label htmlFor={`b-words-${bank.id}-${p}`}>is one whose notice says</Label>
                    <Input
                      id={`b-words-${bank.id}-${p}`}
                      defaultValue={payee.words.join(", ")}
                      placeholder="account ending 1234, Supplier Name Ltd"
                      onChange={(e) => setPayee({ words: list(e.target.value) })}
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`b-quiet-${bank.id}-${p}`}>Tell me after (days)</Label>
                      <Input
                        id={`b-quiet-${bank.id}-${p}`}
                        inputMode="numeric"
                        className="w-24"
                        placeholder="never"
                        defaultValue={payee.quiet_days ?? ""}
                        onChange={(e) => {
                          const days = Number.parseInt(e.target.value, 10);
                          setPayee({
                            quiet_days:
                              Number.isInteger(days) && days >= 1 && days <= 120 ? days : null,
                          });
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setBank(index, { payees: bank.payees.filter((_, i) => i !== p) })
                      }
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })}
            <p className="text-muted-foreground text-xs">
              “Tell me after” shows a notice on the supplier&apos;s page when you still owe them and
              no payment has been filed for that many days.
            </p>
            <div className="flex flex-wrap justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setBank(index, {
                    payees: [...bank.payees, { supplier_id: first, words: [], quiet_days: null }],
                  })
                }
              >
                + Add a supplier
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setConfig((c) => ({ ...c, bank: c.bank.filter((_, i) => i !== index) }))
                }
              >
                Remove this bank
              </Button>
            </div>
          </div>
        ))}
        {config.bank.length < MAX_BANK_SOURCES && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              setConfig((c) => ({
                ...c,
                bank: [
                  ...c.bank,
                  { id: newSourceId(), from: "", label: "", subject_words: [], payees: [] },
                ],
              }))
            }
          >
            + Add a bank
          </Button>
        )}
      </div>

      {showGmail && (
        <div className={box}>
          <h3 className="font-semibold">Reading Gmail directly (optional)</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
            />
            Read supplier emails from my Gmail once a day
          </label>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="read-hour">At about</Label>
            <Select
              id="read-hour"
              className="w-40"
              value={String(config.read_hour)}
              onChange={(e) => setConfig((c) => ({ ...c, read_hour: Number(e.target.value) }))}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {hour === 0
                    ? "12 am"
                    : hour < 12
                      ? `${hour} am`
                      : hour === 12
                        ? "12 pm"
                        : `${hour - 12} pm`}
                </option>
              ))}
            </Select>
          </div>
        </div>
      )}

      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{!dirty ? state.message : undefined}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save who to recognise
      </SubmitButton>
    </form>
  );
}
