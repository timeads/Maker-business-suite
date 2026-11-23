"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_PRINT_SETTINGS,
  PRINT_SETTINGS_KEY,
  printSettings,
  savePrintSettings,
  type PrintSettings,
} from "./settings";

const CHANGED = "shipping-printing-changed";

let seenRaw: string | null | undefined;
let seen: PrintSettings = DEFAULT_PRINT_SETTINGS;
/** What was last chosen on this page, for a browser that won't keep it. */
let chosen: PrintSettings | null = null;

function snapshot(): PrintSettings {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PRINT_SETTINGS_KEY);
  } catch {
    return chosen ?? seen;
  }
  if (raw === null && chosen) return chosen;
  if (raw !== seenRaw) {
    seenRaw = raw;
    seen = printSettings();
  }
  return seen;
}

function subscribe(listener: () => void) {
  const fromElsewhere = () => {
    chosen = null;
    listener();
  };
  window.addEventListener("storage", fromElsewhere);
  window.addEventListener(CHANGED, listener);
  return () => {
    window.removeEventListener("storage", fromElsewhere);
    window.removeEventListener(CHANGED, listener);
  };
}

const onServer = () => DEFAULT_PRINT_SETTINGS;

/**
 * How this computer prints, read from its browser once the page is live. On
 * the server, and wherever the browser keeps nothing, it is ordinary browser
 * printing: every page works without it.
 */
export function usePrintSettings(): [PrintSettings, (next: Partial<PrintSettings>) => void] {
  const settings = useSyncExternalStore(subscribe, snapshot, onServer);
  const save = (next: Partial<PrintSettings>) => {
    chosen = savePrintSettings({ ...snapshot(), ...next });
    window.dispatchEvent(new Event(CHANGED));
  };
  return [settings, save];
}
