import { useCallback, useRef, useState } from "react";
import { reduceDoc, type DocAction, type EmailDoc } from "@/lib/design";

const LIMIT = 200;
/** Changes of the same kind to the same thing this close together count as one step, so typing a sentence is one undo. */
const JOIN_WITHIN = 1000;

interface History {
  past: EmailDoc[];
  present: EmailDoc;
  future: EmailDoc[];
}

/** What a change is "to", for joining a run of them into one undo step. Changes that should always stand alone have none. */
function joinKey(action: DocAction): string | null {
  switch (action.type) {
    case "updateBlock":
    case "updateBlockStyles":
    case "updateSectionStyles":
      return `${action.type}:${action.id}:${Object.keys(action.patch).sort().join(",")}`;
    case "setGlobalStyles":
    case "setMeta":
      return `${action.type}:${Object.keys(action.patch).sort().join(",")}`;
    case "setTitle":
      return action.type;
    case "renameSection":
      return `${action.type}:${action.id}`;
    default:
      return null;
  }
}

/**
 * The document with its undo and redo. Every change goes through `dispatch`, which runs the
 * shared reducer; a change that alters nothing is not recorded.
 */
export function useDocHistory(initial: EmailDoc) {
  const [state, setState] = useState<History>({ past: [], present: initial, future: [] });
  // The newest state, so several changes sent one after another each build on the last.
  const latest = useRef(state);
  const lastJoin = useRef<{ key: string; at: number } | null>(null);

  const set = (next: History) => {
    latest.current = next;
    setState(next);
  };

  /**
   * `quiet` is for changes the owner did not make (a picture finishing its upload): they are
   * applied to every remembered step and add none, so undo never takes them away.
   */
  const dispatch = useCallback((action: DocAction, opts: { quiet?: boolean } = {}) => {
    const cur = latest.current;
    const present = reduceDoc(cur.present, action);
    if (opts.quiet) {
      set({
        past: cur.past.map((d) => reduceDoc(d, action)),
        present,
        future: cur.future.map((d) => reduceDoc(d, action)),
      });
      return;
    }
    if (present === cur.present) return;
    const key = joinKey(action);
    const now = Date.now();
    const join =
      !!key &&
      cur.past.length > 0 &&
      lastJoin.current?.key === key &&
      now - lastJoin.current.at < JOIN_WITHIN;
    lastJoin.current = key ? { key, at: now } : null;
    set({ past: join ? cur.past : [...cur.past, cur.present].slice(-LIMIT), present, future: [] });
  }, []);

  const undo = useCallback(() => {
    const cur = latest.current;
    if (cur.past.length === 0) return;
    lastJoin.current = null;
    set({
      past: cur.past.slice(0, -1),
      present: cur.past[cur.past.length - 1],
      future: [cur.present, ...cur.future],
    });
  }, []);

  const redo = useCallback(() => {
    const cur = latest.current;
    if (cur.future.length === 0) return;
    lastJoin.current = null;
    set({ past: [...cur.past, cur.present], present: cur.future[0], future: cur.future.slice(1) });
  }, []);

  return {
    doc: state.present,
    dispatch,
    undo,
    redo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
