"use client";

import { useActionState, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatMoney } from "@/lib/dashboard/format";
import { boxSize } from "@/lib/shipping/labels";
import type { LearnedBox } from "@/lib/shipping/memory";
import {
  RULE_ACTIONS,
  RULE_ACTION_WORDS,
  RULE_FIELDS,
  RULE_FIELD_KEYS,
  RULE_OP_WORDS,
  ruleSentence,
  shippingRuleSchema,
  signatureOverName,
  type RuleActionType,
  type RuleCondition,
  type RuleField,
  type ShippingRule,
} from "@/lib/shipping/rules";
import type { ShippingState } from "./actions";
import { forgetPacking, saveRememberPacking, saveShippingRules } from "./rules-actions";

const newId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
  )
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 12);

type Draft = {
  id: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  /** Which kinds of thing the rule does, and each one's value. */
  on: Record<RuleActionType, boolean>;
  value: Record<RuleActionType, string>;
  /** For "send it by": cheapest, fastest, or a service typed by name. */
  serviceKind: "cheapest" | "fastest" | "named";
};

const blank = (firstBox: string): Draft => ({
  id: newId(),
  name: "",
  enabled: true,
  conditions: [{ field: "order_total", op: "gt", value: "" }],
  on: { set_package: false, require_signature: false, set_service: false, place_hold: false },
  value: { set_package: firstBox, require_signature: "standard", set_service: "", place_hold: "" },
  serviceKind: "cheapest",
});

function draftOf(rule: ShippingRule, firstBox: string): Draft {
  const draft = blank(firstBox);
  for (const action of rule.actions) {
    draft.on[action.type] = true;
    draft.value[action.type] = action.value;
  }
  const service = draft.value.set_service.toLowerCase();
  return {
    ...draft,
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    conditions: rule.conditions.map((condition) => ({ ...condition })),
    serviceKind: service === "cheapest" || service === "fastest" ? service : "named",
  };
}

const ruleOf = (draft: Draft) => ({
  id: draft.id,
  name: draft.name.trim(),
  enabled: draft.enabled,
  conditions: draft.conditions.map((condition) => ({
    ...condition,
    value: condition.value.trim(),
  })),
  actions: RULE_ACTIONS.filter((type) => draft.on[type]).map((type) => ({
    type,
    value:
      type === "set_service" && draft.serviceKind !== "named"
        ? draft.serviceKind
        : draft.value[type].trim(),
  })),
});

/**
 * The workspace's shipping rules: a list, top to bottom, each "when an order
 * looks like this, do that". Every change is saved as it is made, as one
 * setting, so it can be looked back at like any other.
 */
export function ShippingRulesForm({
  slug,
  rules: saved,
  boxes,
  signatureOver,
  currency,
}: {
  slug: string;
  rules: ShippingRule[];
  /** The names of the boxes a rule can pack in. */
  boxes: string[];
  /** The older "signature on orders of at least" setting, shown as the rule it acts as. */
  signatureOver: number | null;
  currency: string;
}) {
  const [rules, setRules] = useState(saved);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [result, setResult] = useState<ShippingState>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const money = (amount: number) => formatMoney(amount, currency);

  const save = (next: ShippingRule[], after?: () => void) =>
    start(async () => {
      const outcome = await saveShippingRules(slug, next);
      setResult(outcome);
      if (!outcome.error) {
        setRules(next);
        after?.();
      }
    });
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= rules.length) return;
    const next = [...rules];
    [next[index], next[to]] = [next[to], next[index]];
    save(next);
  };
  const keep = () => {
    if (!editing) return;
    const candidate = ruleOf(editing);
    if (!candidate.name) return setProblem("Give the rule a name.");
    if (candidate.conditions.some((condition) => !condition.value)) {
      return setProblem("Each condition needs something to compare with.");
    }
    if (candidate.actions.length === 0) return setProblem("Tick at least one thing for it to do.");
    const parsed = shippingRuleSchema.safeParse(candidate);
    if (!parsed.success) {
      return setProblem(
        editing.on.set_service &&
          editing.serviceKind === "named" &&
          !candidate.actions.find((action) => action.type === "set_service")?.value
          ? "Type the service's name, like UPS Ground."
          : editing.on.set_package && !editing.value.set_package
            ? "Pick the box it goes in. Add your boxes below first."
            : "That rule isn't complete yet. Check each part.",
      );
    }
    setProblem(null);
    const at = rules.findIndex((rule) => rule.id === parsed.data.id);
    save(
      at < 0 ? [...rules, parsed.data] : rules.map((rule, i) => (i === at ? parsed.data : rule)),
      () => setEditing(null),
    );
  };
  const change = (patch: Partial<Draft>) =>
    setEditing((before) => before && { ...before, ...patch });
  const changeCondition = (index: number, patch: Partial<RuleCondition>) =>
    setEditing(
      (before) =>
        before && {
          ...before,
          conditions: before.conditions.map((condition, at) => {
            if (at !== index) return condition;
            const next = { ...condition, ...patch };
            // Another kind of condition takes its own first comparison.
            return RULE_FIELDS[next.field].ops.includes(next.op)
              ? next
              : { ...next, op: RULE_FIELDS[next.field].ops[0] };
          }),
        },
    );
  const row = "border-border flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2";

  return (
    <div className="flex flex-col gap-4">
      {rules.length === 0 && !editing ? (
        <p className="text-muted-foreground text-sm">
          No rules yet. A rule looks at each new order (what&apos;s in it, what it&apos;s worth,
          where it&apos;s going) and picks its box, asks for a signature, picks the service or sets
          it aside on hold, so you don&apos;t have to each time.
        </p>
      ) : (
        <ol className="divide-border border-border flex flex-col divide-y rounded-md border">
          {rules.map((rule, index) => (
            <li key={rule.id} className={row}>
              <label className="flex items-center gap-2" title="Switch this rule on or off">
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={pending}
                  aria-label={`${rule.name}: on`}
                  onChange={(event) =>
                    save(
                      rules.map((each) =>
                        each.id === rule.id ? { ...each, enabled: event.target.checked } : each,
                      ),
                    )
                  }
                />
              </label>
              <span className="min-w-0 flex-1 basis-64">
                <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {rule.name}
                  {!rule.enabled && <Badge>Off</Badge>}
                  {rule.actions.some(
                    (action) =>
                      action.type === "set_package" &&
                      !boxes.some((box) => box.toLowerCase() === action.value.toLowerCase()),
                  ) && <Badge tone="bad">Box not on your list</Badge>}
                </span>
                <span className="text-muted-foreground font-read block text-xs">
                  {ruleSentence(rule, money)}
                </span>
              </span>
              <span className="flex items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === 0 || pending}
                  aria-label={`Move ${rule.name} up`}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === rules.length - 1 || pending}
                  aria-label={`Move ${rule.name} down`}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    setProblem(null);
                    setEditing(draftOf(rule, boxes[0] ?? ""));
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label={`Delete ${rule.name}`}
                  onClick={() => {
                    if (window.confirm(`Delete the rule “${rule.name}”?`)) {
                      save(rules.filter((each) => each.id !== rule.id));
                    }
                  }}
                >
                  <Trash2 />
                </Button>
              </span>
            </li>
          ))}
          {signatureOver !== null && (
            <li className={`${row} bg-sunken/50`}>
              <span className="min-w-0 flex-1 basis-64">
                <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {signatureOverName(signatureOver, money)}
                  <Badge>Built in</Badge>
                </span>
                <span className="text-muted-foreground block text-xs">
                  From “When you buy a label” above. It comes after your own rules, so one of them
                  can ask for an adult signature instead.
                </span>
              </span>
            </li>
          )}
        </ol>
      )}
      {rules.length > 1 && !editing && (
        <p className="text-muted-foreground -mt-2 text-xs">
          Top to bottom: when two rules would pick a box (or a service, a signature, a hold) for the
          same order, the higher one wins. A choice you make on an order&apos;s own page always
          comes first.
        </p>
      )}

      {editing ? (
        <div className="border-border bg-sunken flex flex-col gap-4 rounded-md border p-3 sm:p-4">
          <div className="flex flex-col gap-1.5 sm:max-w-md">
            <Label htmlFor="rule-name">Name</Label>
            <Input
              id="rule-name"
              value={editing.name}
              maxLength={80}
              placeholder="Machines need a signature"
              onChange={(event) => change({ name: event.target.value })}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">When all of these are true</legend>
            {editing.conditions.map((condition, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Select
                  aria-label="What to look at"
                  className="w-full sm:w-56"
                  value={condition.field}
                  onChange={(event) =>
                    changeCondition(index, { field: event.target.value as RuleField })
                  }
                >
                  {RULE_FIELD_KEYS.map((field) => (
                    <option key={field} value={field}>
                      {RULE_FIELDS[field].label}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="How to compare"
                  className="w-full sm:w-44"
                  value={condition.op}
                  onChange={(event) =>
                    changeCondition(index, { op: event.target.value as RuleCondition["op"] })
                  }
                >
                  {RULE_FIELDS[condition.field].ops.map((op) => (
                    <option key={op} value={op}>
                      {RULE_OP_WORDS[op]}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label="Value"
                  className="min-w-0 flex-1 basis-48"
                  value={condition.value}
                  maxLength={500}
                  placeholder={RULE_FIELDS[condition.field].hint}
                  onChange={(event) => changeCondition(index, { value: event.target.value })}
                />
                {editing.conditions.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Remove this condition"
                    onClick={() =>
                      change({ conditions: editing.conditions.filter((_, at) => at !== index) })
                    }
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
            {editing.conditions.length < 10 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() =>
                  change({
                    conditions: [
                      ...editing.conditions,
                      { field: "product_names", op: "includes_any", value: "" },
                    ],
                  })
                }
              >
                <Plus aria-hidden />
                Add a condition
              </Button>
            )}
          </fieldset>
          <fieldset className="flex flex-col gap-2.5">
            <legend className="mb-1 text-sm font-semibold">Then</legend>
            {RULE_ACTIONS.map((type) => (
              <div key={type} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <label className="flex w-48 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={editing.on[type]}
                    onChange={(event) =>
                      change({ on: { ...editing.on, [type]: event.target.checked } })
                    }
                  />
                  {RULE_ACTION_WORDS[type]}
                </label>
                {editing.on[type] &&
                  (type === "set_package" ? (
                    boxes.length > 0 ? (
                      <Select
                        aria-label="Box"
                        className="w-full sm:w-64"
                        value={editing.value.set_package}
                        onChange={(event) =>
                          change({ value: { ...editing.value, set_package: event.target.value } })
                        }
                      >
                        {!boxes.includes(editing.value.set_package) && (
                          <option value={editing.value.set_package}>
                            {editing.value.set_package || "Pick a box"}
                          </option>
                        )}
                        {boxes.map((box) => (
                          <option key={box} value={box}>
                            {box}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-muted-foreground text-xs">
                        Add your boxes below first.
                      </span>
                    )
                  ) : type === "require_signature" ? (
                    <Select
                      aria-label="Which signature"
                      className="w-full sm:w-64"
                      value={editing.value.require_signature}
                      onChange={(event) =>
                        change({
                          value: { ...editing.value, require_signature: event.target.value },
                        })
                      }
                    >
                      <option value="standard">Signature on delivery</option>
                      <option value="adult">An adult&apos;s signature</option>
                    </Select>
                  ) : type === "set_service" ? (
                    <>
                      <Select
                        aria-label="Which service"
                        className="w-full sm:w-52"
                        value={editing.serviceKind}
                        onChange={(event) =>
                          change({ serviceKind: event.target.value as Draft["serviceKind"] })
                        }
                      >
                        <option value="cheapest">The cheapest service</option>
                        <option value="fastest">The fastest service</option>
                        <option value="named">A service by name…</option>
                      </Select>
                      {editing.serviceKind === "named" && (
                        <Input
                          aria-label="Service name"
                          className="min-w-0 flex-1 basis-48"
                          maxLength={120}
                          placeholder="UPS Ground"
                          value={
                            ["cheapest", "fastest"].includes(
                              editing.value.set_service.toLowerCase(),
                            )
                              ? ""
                              : editing.value.set_service
                          }
                          onChange={(event) =>
                            change({ value: { ...editing.value, set_service: event.target.value } })
                          }
                        />
                      )}
                    </>
                  ) : (
                    <Input
                      aria-label="Why it's on hold"
                      className="min-w-0 flex-1 basis-48"
                      maxLength={300}
                      placeholder="Why it waits, e.g. check the colour with the customer"
                      value={editing.value.place_hold}
                      onChange={(event) =>
                        change({ value: { ...editing.value, place_hold: event.target.value } })
                      }
                    />
                  ))}
              </div>
            ))}
            {editing.on.set_service && editing.serviceKind === "named" && (
              <p className="text-muted-foreground text-xs">
                Type it as it reads in the list of rates, like “UPS Ground” or “USPS Ground
                Advantage”. If no carrier offers it for an order, the cheapest is used instead.
              </p>
            )}
          </fieldset>
          <FormMessage>{problem}</FormMessage>
          <div className="flex gap-2">
            <Button type="button" variant="dark" size="sm" disabled={pending} onClick={keep}>
              {pending ? "Saving…" : "Save rule"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(null);
                setProblem(null);
              }}
            >
              Never mind
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="sm:w-fit"
          disabled={pending || rules.length >= 50}
          onClick={() => {
            setProblem(null);
            setResult({});
            setEditing(blank(boxes[0] ?? ""));
          }}
        >
          <Plus aria-hidden />
          Add a rule
        </Button>
      )}
      <FormMessage>{result.error}</FormMessage>
      <FormMessage kind="success">{result.message}</FormMessage>
    </div>
  );
}

/** "Remember how I pack": the two switches. */
export function RememberPackingForm({
  slug,
  remember,
}: {
  slug: string;
  remember: { exact: boolean; similar: boolean };
}) {
  const [state, action] = useActionState(saveRememberPacking.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="remember_exact"
          defaultChecked={remember.exact}
          className="mt-0.5"
        />
        <span>
          Start an order with the very same items in the same boxes, split and weights as last time
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="remember_similar"
          defaultChecked={remember.similar}
          className="mt-0.5"
        />
        <span>
          Start an order with the same products in other quantities in the same box (the weight
          comes from your shop)
        </span>
      </label>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

export type RememberedRow = {
  id: string;
  /** "1 × AK5 machine, 4 × Yarn (Mustard)" */
  label: string;
  boxes: LearnedBox[];
  uses: number;
  /** "Nov 20" */
  when: string;
};

function ForgetButton({ slug, id }: { slug: string; id: string }) {
  const [state, action] = useActionState(forgetPacking.bind(null, slug, id), {});
  return (
    <form action={action} className="flex items-center gap-2">
      {state.error && <span className="text-brick text-xs">{state.error}</span>}
      <SubmitButton variant="ghost" size="sm" pendingText="Forgetting…">
        Forget
      </SubmitButton>
    </form>
  );
}

/** What has been remembered, newest first, with a way to find one and forget it. */
export function RememberedPackings({
  slug,
  rows,
  boxNames,
}: {
  slug: string;
  rows: RememberedRow[];
  /** Saved boxes by id, for saying which box it was. */
  boxNames: Record<string, string>;
}) {
  const [find, setFind] = useState("");
  const wanted = find.trim().toLowerCase();
  const shown = wanted ? rows.filter((row) => row.label.toLowerCase().includes(wanted)) : rows;
  const boxWords = (box: LearnedBox) =>
    `${(box.box_id && boxNames[box.box_id]) || boxSize({ length_in: box.length, width_in: box.width, height_in: box.height })}${
      box.weight_tenth_oz > 0 ? `, ${Math.round(box.weight_tenth_oz / 1.6) / 100} lb` : ""
    }`;
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing remembered yet. It starts with the next label you buy for a whole order.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.length > 6 && (
        <Input
          type="search"
          value={find}
          maxLength={60}
          aria-label="Find a remembered packing"
          placeholder="Find by item…"
          className="sm:max-w-xs"
          onChange={(event) => setFind(event.target.value)}
        />
      )}
      <ul className="divide-border border-border flex max-h-96 flex-col divide-y overflow-y-auto rounded-md border">
        {shown.slice(0, 100).map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="min-w-0 flex-1 basis-64">
              <span className="font-read block text-sm">{row.label || "Items"}</span>
              <span className="text-muted-foreground block text-xs">
                {row.boxes.length === 1 ? "" : `${row.boxes.length} boxes: `}
                {row.boxes.map(boxWords).join(" + ")} · used{" "}
                {row.uses === 1 ? "once" : `${row.uses} times`} · last {row.when}
              </span>
            </span>
            <ForgetButton slug={slug} id={row.id} />
          </li>
        ))}
        {shown.length === 0 && (
          <li className="text-muted-foreground px-3 py-2 text-sm">Nothing matches.</li>
        )}
      </ul>
    </div>
  );
}
