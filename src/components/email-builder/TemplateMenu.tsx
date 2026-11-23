"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Trash2 } from "lucide-react";
import { toast } from "./ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui";
import { Input } from "@/components/ui/input";
import { listTemplates, storeTemplates } from "@/lib/emails";
import { MAX_TEMPLATES, templateFrom, type EmailTemplate } from "@/lib/design";
import { useAuth } from "@/hooks/useAuth";
import { useBuilder } from "./context";
import { TemplateChooser } from "./TemplateChooser";
import { TEMPLATES_KEY, findTemplate } from "./shared";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The menu beside "Save and exit": keep this email's layout as a template, or change it for another. */
export function TemplateMenu() {
  const { doc, dispatch, select } = useBuilder();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: saved = [] } = useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: listTemplates,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const [open, setOpen] = useState<"save" | "change" | null>(null);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);

  const store = async (next: EmailTemplate[], done: string) => {
    if (!user) return false;
    setBusy(true);
    try {
      await storeTemplates(user.id, next);
      queryClient.setQueryData(TEMPLATES_KEY, next);
      toast.success(done);
      return true;
    } catch (err) {
      toast.error(`Your templates could not be updated: ${message(err)}`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (saved.length >= MAX_TEMPLATES)
      return void toast.error(
        `You have ${MAX_TEMPLATES} templates, which is the most that can be kept. Delete one first, under Change template.`,
      );
    if (
      await store(
        [templateFrom(doc, name), ...saved],
        `"${name.trim() || doc.title}" saved as a template.`,
      )
    )
      setOpen(null);
  };
  const change = () => {
    const template = findTemplate(chosen, doc.brand, saved);
    if (!template) return;
    dispatch({
      type: "applyTemplate",
      globalStyles: template.globalStyles,
      sections: template.sections,
    });
    select(null);
    setOpen(null);
    toast.success("Template changed. Undo brings back what was there.");
  };
  const mine = saved.find((t) => t.id === chosen);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-l-none px-2"
            aria-label="Templates"
            title="Templates"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={() => {
              setName(doc.title);
              setOpen("save");
            }}
          >
            Save as a template
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setChosen("");
              setOpen("change");
            }}
          >
            Change template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open === "save"} onOpenChange={(v) => !v && !busy && setOpen(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save as a template</DialogTitle>
            <DialogDescription>
              Keeps this email's layout, styles and content to start other emails from. The subject
              and preview text are not kept.
            </DialogDescription>
          </DialogHeader>
          <label className="block space-y-1">
            <span className="block text-xs font-medium">Template name</span>
            <Input
              autoFocus
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) save();
              }}
            />
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              Save template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "change"} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Change template</DialogTitle>
            <DialogDescription>Choose a layout to change this email to.</DialogDescription>
          </DialogHeader>
          <TemplateChooser brand={doc.brand} saved={saved} value={chosen} onChange={setChosen} />
          <p
            className="border-note-border bg-note text-foreground rounded-md border p-2.5 text-xs leading-relaxed"
            role="note"
          >
            This replaces everything in the email (its sections, content and styles) with the
            template's. Your subject and preview text stay. Undo brings back what was there.
          </p>
          <DialogFooter className="sm:justify-between">
            {mine ? (
              <Button
                variant="ghost"
                className="text-brick"
                disabled={busy}
                onClick={async () => {
                  if (
                    window.confirm(
                      `Delete your template "${mine.name}"? Emails made from it are not changed.`,
                    ) &&
                    (await store(
                      saved.filter((t) => t.id !== mine.id),
                      "Template deleted.",
                    ))
                  )
                    setChosen("");
                }}
              >
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete this template
              </Button>
            ) : (
              <span />
            )}
            <span className="flex gap-2">
              <Button variant="ghost" onClick={() => setOpen(null)}>
                Cancel
              </Button>
              <Button onClick={change} disabled={!chosen}>
                Use this template
              </Button>
            </span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
