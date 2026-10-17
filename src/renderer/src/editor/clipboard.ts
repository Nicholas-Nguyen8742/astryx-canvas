import type { DiagramObject } from "../document/model";
import { PASTE_OFFSET, cloneObject } from "./factories";

const NO_OFFSET = { x: 0, y: 0 };

/**
 * Clipboard payload construction (FR-OBJ-16, FR-OBJ-05).
 *
 * Kept as pure functions over plain arrays rather than store methods so the
 * copy/paste rules are testable without React, a DOM or Electron — the same
 * reasoning as the command layer.
 */

/**
 * Builds the clipboard payload from the current selection.
 *
 * Copies are detached with fresh ids and no offset, so the payload is a stable
 * snapshot: editing or deleting the originals afterwards cannot change what a
 * later paste produces, and pasting twice cannot collide on an id.
 *
 * Order follows the document, not the selection, so a paste restores the same
 * stacking relationship the objects had.
 */
export function copyObjects(
  objects: readonly DiagramObject[],
  ids: readonly string[],
): DiagramObject[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  return objects.filter((object) => wanted.has(object.id)).map((object) => cloneObject(object, NO_OFFSET));
}

/**
 * Builds the objects to insert for one paste.
 *
 * `step` cascades repeated pastes so each copy lands visibly offset from the
 * last instead of stacking invisibly on top of it. Ids are regenerated on every
 * call, which is what makes paste-twice produce two distinct objects.
 */
export function pasteObjects(
  clipboard: readonly DiagramObject[],
  step: number,
): DiagramObject[] {
  if (clipboard.length === 0) return [];
  const multiplier = Math.max(step, 1);
  const offset = { x: PASTE_OFFSET.x * multiplier, y: PASTE_OFFSET.y * multiplier };
  return clipboard.map((object) => cloneObject(object, offset));
}

/**
 * Cut is copy plus delete, but the payload must be captured *before* the delete
 * runs: the command removes the objects from the document, so reading them
 * afterwards would yield nothing.
 */
export function cutObjects(
  objects: readonly DiagramObject[],
  ids: readonly string[],
): { payload: DiagramObject[]; ids: string[] } {
  return { payload: copyObjects(objects, ids), ids: [...ids] };
}
