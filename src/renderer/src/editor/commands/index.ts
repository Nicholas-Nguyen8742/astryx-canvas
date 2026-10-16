import type { DiagramObject, DiagramStyle, Transform } from "../../document/model";

/**
 * An object plus the array index it occupied, so a delete can be undone back
 * into its original z-position rather than being appended on top.
 */
export interface ExtractedObject {
  object: DiagramObject;
  index: number;
}

/**
 * The slice of the document store that commands are allowed to touch.
 *
 * Commands depend on this rather than on the store itself so they can be
 * exercised in a node environment with no React and no DOM (TRD §22.1, and
 * NFR-MAINT-04's requirement that state transitions be predictable and
 * testable). Every method is a raw mutation: none of them records history,
 * because recording history is the command's job.
 */
export interface DocumentMutator {
  insertObjects(objects: readonly DiagramObject[]): void;
  extractObjects(ids: readonly string[]): ExtractedObject[];
  restoreObjects(extracted: readonly ExtractedObject[]): void;
  setTransforms(entries: Readonly<Record<string, Transform>>): void;
  setStyles(entries: Readonly<Record<string, DiagramStyle>>): void;
  getTransforms(ids: readonly string[]): Record<string, Transform>;
  getStyles(ids: readonly string[]): Record<string, DiagramStyle>;
}

/**
 * A reversible edit (TRD §13.3).
 *
 * `execute` and `undo` must be exact inverses and must both be idempotent when
 * called repeatedly, because a redo replays `execute` on state that `undo`
 * already restored.
 */
export interface EditorCommand {
  readonly id: string;
  /** User-facing name, surfaced in the Edit menu and tooltips (FR-HIST-05). */
  readonly label: string;
  /** ISO 8601. */
  readonly timestamp: string;
  execute(): void;
  undo(): void;
  /**
   * Called on the *incoming* command with the current top of the undo stack.
   * Return true if the incoming edit has been folded into `previous` and should
   * therefore not be pushed as its own entry (FR-HIST-04 coalescing).
   */
  merge?(previous: EditorCommand): boolean;
}
