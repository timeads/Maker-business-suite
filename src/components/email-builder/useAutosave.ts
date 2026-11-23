import { useCallback, useEffect, useRef, useState } from "react";

export type SaveStatus = "saved" | "saving" | "error";

/**
 * Saves a value a moment after it last changed. `flush` saves at once and resolves to whether
 * everything is now saved; it is used when leaving, when the window loses focus, and by Retry.
 */
export function useAutosave<T>(value: T, save: (value: T) => Promise<void>, delay = 1000) {
  const [status, setStatus] = useState<SaveStatus>("saved");
  const saved = useRef(value);
  const latest = useRef(value);
  const saveRef = useRef(save);
  saveRef.current = save;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Saves run one after another, so an older save can never land after a newer one.
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const alive = useRef(true);

  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const show = (next: SaveStatus) => {
      if (alive.current) setStatus(next);
    };
    const run = async (): Promise<boolean> => {
      // Keep going until what is on screen is what is saved: more may change while a save is on its way.
      while (latest.current !== saved.current) {
        const target = latest.current;
        show("saving");
        try {
          await saveRef.current(target);
          saved.current = target;
        } catch {
          show("error");
          return false;
        }
      }
      show("saved");
      return true;
    };
    queue.current = queue.current.then(run, run);
    return queue.current;
  }, []);

  useEffect(() => {
    latest.current = value;
    if (value === saved.current) return;
    setStatus("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush();
    }, delay);
  }, [value, delay, flush]);

  useEffect(() => {
    alive.current = true;
    const warn = (e: BeforeUnloadEvent) => {
      if (latest.current === saved.current) return;
      flush();
      e.preventDefault();
      e.returnValue = "";
    };
    const leave = () => {
      flush();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", hidden);
      // Leaving the builder by any route saves what is left.
      alive.current = false;
      flush();
    };
  }, [flush]);

  return { status, flush };
}
