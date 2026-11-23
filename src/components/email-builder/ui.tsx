"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Slot } from "@radix-ui/react-slot";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The few interface pieces the email builder needs that the house set does not have yet:
 * a dialog, a menu, a pop-up panel, tabs, an accordion, a switch, a text box and a toast.
 * Each is the smallest thing that does the job, with no library behind it.
 */

function useCtx<T>(context: React.Context<T | null>, name: string): T {
  const value = useContext(context);
  if (!value) throw new Error(`${name} is used outside its parent`);
  return value;
}

/* ───────────── A tiny store, for the toasts and for which dialog is on top ───────────── */

function makeStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/* ───────────── Dialog ───────────── */

// The dialogs that are open, the last one on top. A toast is shown inside the top one, since a
// modal dialog covers everything outside itself.
const openDialogs = makeStore<HTMLDialogElement[]>([]);

type DialogCtx = {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  textId: string;
};
const DialogContext = createContext<DialogCtx | null>(null);

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const textId = useId();
  return (
    <DialogContext.Provider value={{ open, setOpen: onOpenChange, titleId, textId }}>
      {children}
    </DialogContext.Provider>
  );
}

/** The dialog's box. It is the browser's own <dialog>, so Escape, the backdrop and where the cursor goes are the browser's doing. */
export function DialogContent({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const { open, setOpen, titleId, textId } = useCtx(DialogContext, "DialogContent");
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    if (!el.open) el.showModal();
    openDialogs.set([...openDialogs.get(), el]);
    return () => {
      openDialogs.set(openDialogs.get().filter((d) => d !== el));
      if (el.open) el.close();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={textId}
      className="fixed inset-0 m-0 grid h-full max-h-none w-full max-w-none place-items-center bg-transparent p-4 backdrop:bg-black/50"
      onCancel={(e) => {
        // Escape. The dialog is closed by its owner, who may want to keep it open (while saving, say).
        e.preventDefault();
        setOpen(false);
      }}
      onPointerDown={(e) => {
        // A press on the dialog itself, not on the box in it, is a press on the backdrop.
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className={cn(
          "bg-card text-foreground border-border relative grid max-h-full w-full max-w-lg gap-4 rounded-lg border p-6 shadow-lg",
          className,
        )}
      >
        {children}
        <button
          type="button"
          aria-label="Close"
          onClick={() => setOpen(false)}
          className="text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring absolute top-2.5 right-2.5 flex size-7 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </dialog>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("space-y-1 pr-8", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  const { titleId } = useCtx(DialogContext, "DialogTitle");
  return <h2 id={titleId} className={cn("text-base font-bold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
  const { textId } = useCtx(DialogContext, "DialogDescription");
  return <p id={textId} className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap justify-end gap-2", className)} {...props} />;
}

/* ───────────── What menus and pop-up panels share ───────────── */

type FloatCtx = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The id of the wrapper round the button and its panel, of the button, and of the panel. */
  rootId: string;
  triggerId: string;
  panelId: string;
  /** Put the cursor back on the button. */
  focusTrigger: () => void;
};

function useFloat(
  controlled: boolean | undefined,
  onOpenChange?: (open: boolean) => void,
): FloatCtx {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = useCallback(
    (next: boolean) => {
      setOwn(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const id = useId();
  const rootId = `${id}root`;
  const triggerId = `${id}trigger`;
  const panelId = `${id}panel`;
  const focusTrigger = useCallback(() => document.getElementById(triggerId)?.focus(), [triggerId]);
  // A press anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && document.getElementById(rootId)?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open, setOpen, rootId]);
  return { open, setOpen, rootId, triggerId, panelId, focusTrigger };
}

const panelClass =
  "bg-card text-foreground border-border absolute top-full z-50 mt-1 rounded-md border shadow-lg";

/* ───────────── Menu ───────────── */

type CloseEvent = { preventDefault: () => void };
type MenuCtx = FloatCtx & { close: (onCloseAutoFocus?: (e: CloseEvent) => void) => void };
const MenuContext = createContext<MenuCtx | null>(null);
const MenuContentContext = createContext<((e: CloseEvent) => void) | undefined>(undefined);

export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const float = useFloat(undefined);
  const { setOpen, focusTrigger } = float;
  // Closing by choice (an item, Escape) hands the cursor back to the button, unless the menu's owner says otherwise.
  const close = useCallback(
    (onCloseAutoFocus?: (e: CloseEvent) => void) => {
      setOpen(false);
      let stay = false;
      onCloseAutoFocus?.({ preventDefault: () => (stay = true) });
      if (!stay) focusTrigger();
    },
    [setOpen, focusTrigger],
  );
  return (
    <MenuContext.Provider value={{ ...float, close }}>
      <span id={float.rootId} className="relative inline-flex">
        {children}
      </span>
    </MenuContext.Provider>
  );
}

export function DropdownMenuTrigger({
  children,
}: {
  asChild?: boolean;
  children: React.ReactElement;
}) {
  const { open, setOpen, triggerId, panelId } = useCtx(MenuContext, "DropdownMenuTrigger");
  return (
    <Slot
      id={triggerId}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(!open)}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown" && !open) {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      {children}
    </Slot>
  );
}

const menuItems = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));

export function DropdownMenuContent({
  align = "start",
  className,
  onCloseAutoFocus,
  children,
}: {
  align?: "start" | "end";
  className?: string;
  onCloseAutoFocus?: (e: CloseEvent) => void;
  children: React.ReactNode;
}) {
  const { open, close, panelId } = useCtx(MenuContext, "DropdownMenuContent");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && ref.current) (menuItems(ref.current)[0] ?? ref.current).focus();
  }, [open]);
  if (!open) return null;
  return (
    <MenuContentContext.Provider value={onCloseAutoFocus}>
      <div
        ref={ref}
        id={panelId}
        role="menu"
        tabIndex={-1}
        data-state="open"
        className={cn(
          panelClass,
          "p-1 outline-none",
          align === "end" ? "right-0" : "left-0",
          className,
        )}
        onKeyDown={(e) => {
          const items = menuItems(e.currentTarget);
          const at = items.indexOf(document.activeElement as HTMLElement);
          const go = (i: number) => {
            e.preventDefault();
            items[(i + items.length) % items.length]?.focus();
          };
          if (e.key === "Escape") {
            // Acted on here, so it is not also a shortcut for the builder.
            e.preventDefault();
            close(onCloseAutoFocus);
          } else if (e.key === "ArrowDown") go(at + 1);
          else if (e.key === "ArrowUp") go(at < 0 ? -1 : at - 1);
          else if (e.key === "Home") go(0);
          else if (e.key === "End") go(-1);
          else if (e.key === "Tab") close(onCloseAutoFocus);
        }}
      >
        {children}
      </div>
    </MenuContentContext.Provider>
  );
}

export function DropdownMenuItem({
  className,
  disabled,
  onSelect,
  children,
}: {
  className?: string;
  disabled?: boolean;
  onSelect?: () => void;
  children: React.ReactNode;
}) {
  const { close } = useCtx(MenuContext, "DropdownMenuItem");
  const onCloseAutoFocus = useContext(MenuContentContext);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      className={cn(
        "hover:bg-hover focus:bg-hover flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      onClick={() => {
        onSelect?.();
        close(onCloseAutoFocus);
      }}
    >
      {children}
    </button>
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-2 py-1.5 text-sm font-semibold", className)} {...props} />;
}

export function DropdownMenuSeparator() {
  return <div role="separator" className="bg-border -mx-1 my-1 h-px" />;
}

/* ───────────── Pop-up panel ───────────── */

const PopoverContext = createContext<FloatCtx | null>(null);

export function Popover({
  open,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const float = useFloat(open, onOpenChange);
  return (
    <PopoverContext.Provider value={float}>
      <span id={float.rootId} className="relative inline-flex">
        {children}
      </span>
    </PopoverContext.Provider>
  );
}

export function PopoverTrigger({ children }: { asChild?: boolean; children: React.ReactElement }) {
  const { open, setOpen, triggerId, panelId } = useCtx(PopoverContext, "PopoverTrigger");
  return (
    <Slot
      id={triggerId}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={() => setOpen(!open)}
    >
      {children}
    </Slot>
  );
}

export function PopoverContent({
  align = "start",
  className,
  children,
  ...props
}: {
  align?: "start" | "end";
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}) {
  const { open, setOpen, focusTrigger, panelId } = useCtx(PopoverContext, "PopoverContent");
  if (!open) return null;
  return (
    <div
      id={panelId}
      role="dialog"
      data-state="open"
      className={cn(panelClass, "p-4", align === "end" ? "right-0" : "left-0", className)}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        setOpen(false);
        focusTrigger();
      }}
      {...props}
    >
      {children}
    </div>
  );
}

/* ───────────── Tabs ───────────── */

type TabsCtx = { value: string; setValue: (value: string) => void; id: string };
const TabsContext = createContext<TabsCtx | null>(null);

export function Tabs({
  value,
  defaultValue = "",
  onValueChange,
  className,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const [own, setOwn] = useState(defaultValue);
  const id = useId();
  const setValue = (next: string) => {
    setOwn(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext.Provider value={{ value: value ?? own, setValue, id }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="tablist"
      className={cn("bg-sunken items-center gap-0.5 rounded-md p-0.5", className)}
      onKeyDown={(e) => {
        const tabs = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'),
        );
        const at = tabs.indexOf(document.activeElement as HTMLElement);
        if (at < 0) return;
        const to =
          e.key === "ArrowRight"
            ? at + 1
            : e.key === "ArrowLeft"
              ? at - 1
              : e.key === "Home"
                ? 0
                : e.key === "End"
                  ? tabs.length - 1
                  : null;
        if (to === null) return;
        e.preventDefault();
        const tab = tabs[(to + tabs.length) % tabs.length];
        tab.focus();
        tab.click();
      }}
      {...props}
    />
  );
}

export function TabsTrigger({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const tabs = useCtx(TabsContext, "TabsTrigger");
  const on = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${tabs.id}-tab-${value}`}
      aria-selected={on}
      aria-controls={`${tabs.id}-panel-${value}`}
      tabIndex={on ? 0 : -1}
      onClick={() => tabs.setValue(value)}
      className={cn(
        "focus-visible:ring-ring h-full rounded-sm px-3 text-sm font-semibold outline-none focus-visible:ring-2",
        on ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const tabs = useCtx(TabsContext, "TabsContent");
  if (tabs.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${tabs.id}-panel-${value}`}
      aria-labelledby={`${tabs.id}-tab-${value}`}
      className={cn("mt-3", className)}
    >
      {children}
    </div>
  );
}

/* ───────────── Accordion: one part open at a time ───────────── */

type AccordionCtx = { value: string; setValue: (value: string) => void };
const AccordionContext = createContext<AccordionCtx | null>(null);

export function Accordion({
  defaultValue = "",
  className,
  children,
}: {
  type?: "single";
  collapsible?: boolean;
  defaultValue?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <AccordionContext.Provider value={{ value, setValue }}>
      <div className={className}>{children}</div>
    </AccordionContext.Provider>
  );
}

export function AccordionItem({ value, children }: { value: string; children: React.ReactNode }) {
  const accordion = useCtx(AccordionContext, "AccordionItem");
  return (
    <details
      className="group/acc border-border border-b"
      open={accordion.value === value}
      onToggle={(e) => {
        const open = e.currentTarget.open;
        if (open && accordion.value !== value) accordion.setValue(value);
        else if (!open && accordion.value === value) accordion.setValue("");
      }}
    >
      {children}
    </details>
  );
}

export function AccordionTrigger({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <summary
      className={cn(
        "focus-visible:ring-ring flex cursor-pointer list-none items-center justify-between rounded-sm font-semibold outline-none hover:underline focus-visible:ring-2 [&::-webkit-details-marker]:hidden",
        className,
      )}
    >
      {children}
      <ChevronDown
        className="text-muted-foreground size-4 shrink-0 transition-transform group-open/acc:rotate-180"
        aria-hidden
      />
    </summary>
  );
}

export function AccordionContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("pb-4", className)} {...props} />;
}

/* ───────────── Switch and text box ───────────── */

export function Switch({
  checked,
  onCheckedChange,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "role" | "checked" | "onChange"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      className={cn(
        "bg-input checked:bg-teal focus-visible:ring-ring focus-visible:ring-offset-card before:bg-card relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full transition-colors outline-none before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-full before:shadow-sm before:transition-transform before:content-[''] checked:before:translate-x-4 focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 min-h-[60px] w-full rounded-sm border px-[11px] py-2 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

/* ───────────── Toast ───────────── */

type Toast = { id: number; kind: "success" | "error"; text: string };
const toasts = makeStore<Toast[]>([]);
let lastToast = 0;
const TOAST_MS = 5000;

function show(kind: Toast["kind"], text: string) {
  const id = ++lastToast;
  // A few at most, so a run of them never covers the work.
  toasts.set([...toasts.get(), { id, kind, text }].slice(-3));
  window.setTimeout(() => toasts.set(toasts.get().filter((t) => t.id !== id)), TOAST_MS);
}

/** A short word that something worked, or did not. It goes away by itself. */
export const toast = {
  success: (text: string) => show("success", text),
  error: (text: string) => show("error", text),
};

const never = () => () => undefined;
const noToasts: Toast[] = [];
const noDialogs: HTMLDialogElement[] = [];

/** Where toasts are shown. Rendered once, by the builder. */
export function Toaster() {
  const list = useSyncExternalStore(toasts.subscribe, toasts.get, () => noToasts);
  const dialogs = useSyncExternalStore(openDialogs.subscribe, openDialogs.get, () => noDialogs);
  // Nothing on the server: there is no page to put them on yet.
  const ready = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  if (!ready) return null;
  // An open dialog covers the rest of the page, so the toasts go inside the one on top.
  const home = dialogs[dialogs.length - 1] ?? document.body;
  return createPortal(
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {list.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2.5 text-left text-sm shadow-lg",
            t.kind === "error"
              ? "border-brick bg-brick-soft text-foreground"
              : "border-border bg-card text-foreground",
          )}
        >
          <span className="min-w-0 flex-1">{t.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground shrink-0"
            onClick={() => toasts.set(toasts.get().filter((x) => x.id !== t.id))}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>,
    home,
  );
}
