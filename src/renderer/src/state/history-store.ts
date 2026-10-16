import { create } from "zustand";

import type { EditorCommand } from "../editor/commands";

/** FR-HIST-02 requires at least 100 undo steps; 200 gives real headroom. */
export const MAX_HISTORY = 200;

export interface HistoryState {
  past: EditorCommand[];
  /** Most recently undone command first, so `redo` replays in reverse. */
  future: EditorCommand[];
  /** Run a command, then record it. */
  execute(command: EditorCommand): void;
  /**
   * Record a command whose effect is *already applied*. This is how a drag ends:
   * the pointer handlers move objects directly while dragging so the canvas stays
   * responsive, and only the finished gesture becomes one undo entry
   * (TRD §13.2 rule 2).
   */
  commit(command: EditorCommand): void;
  undo(): void;
  redo(): void;
  clear(): void;
}

export function createHistoryStore(limit: number = MAX_HISTORY) {
  return create<HistoryState>()((set, get) => {
    const push = (command: EditorCommand): void => {
      const { past } = get();
      const top = past[past.length - 1];

      // Coalescing (FR-HIST-04): the incoming command decides whether it folds
      // into the entry already on the stack, e.g. consecutive nudges of the same
      // objects becoming one undoable step.
      if (top && top !== command && command.merge?.(top) === true) {
        set({ future: [] });
        return;
      }

      const next = [...past, command];
      set({
        past: next.length > limit ? next.slice(next.length - limit) : next,
        future: [],
      });
    };

    return {
      past: [],
      future: [],

      execute(command) {
        command.execute();
        push(command);
      },

      commit(command) {
        push(command);
      },

      undo() {
        const { past, future } = get();
        const command = past[past.length - 1];
        if (!command) return;
        command.undo();
        set({ past: past.slice(0, -1), future: [command, ...future] });
      },

      redo() {
        const { past, future } = get();
        const command = future[0];
        if (!command) return;
        command.execute();
        set({ past: [...past, command], future: future.slice(1) });
      },

      clear() {
        set({ past: [], future: [] });
      },
    };
  });
}

export const useHistoryStore = createHistoryStore();
