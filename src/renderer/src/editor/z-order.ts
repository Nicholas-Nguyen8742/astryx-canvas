/**
 * Paint-order arithmetic (FR-OBJ-11).
 *
 * Pure over an id list so the rules can be tested with no document, store or
 * DOM. The ordering question is entirely "which id comes first"; objects,
 * styles and history are somebody else's job.
 *
 * Later in the array means higher in the stack. That is SVG paint order, and it
 * is what both the live canvas and the export writer already consume, so this
 * module changes no convention — it only rearranges one.
 */

/** The four z-order operations. "front" is the top of the stack. */
export type ZOrderMove = "front" | "back" | "forward" | "backward";

const MOVE_LABELS: Record<ZOrderMove, string> = {
  front: "Bring to front",
  back: "Send to back",
  forward: "Bring forward",
  backward: "Send backward",
};

/** User-facing name, surfaced on buttons and in the history list (FR-HIST-05). */
export function zOrderLabel(move: ZOrderMove): string {
  return MOVE_LABELS[move];
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Returns the new paint order, or `null` when the move would change nothing.
 *
 * The `null` is load-bearing, not a convenience: a no-op reorder must not become
 * an undo entry. Without it, holding Ctrl+] on an already-frontmost shape would
 * push hundreds of empty entries and evict real work from the history cap
 * (FR-HIST-02) while leaving the user nothing to undo back to.
 *
 * A multi-selection moves as a block, and blocked members stay put rather than
 * wrapping to the other end — the behaviour users expect from every other
 * drawing tool, and the one that cannot lose an object off the stack.
 */
export function reorderIds(
  order: readonly string[],
  ids: readonly string[],
  move: ZOrderMove,
): string[] | null {
  const wanted = new Set(ids);
  // Filter from `order`, not from `ids`: only ids that are actually present can
  // move, and this keeps the selection's own relative order. A stale selection
  // still holding a deleted id would otherwise vanish from the result and take
  // an object out of the document with it.
  const targets = order.filter((id) => wanted.has(id));
  if (targets.length === 0) return null;
  const isTarget = new Set(targets);

  if (move === "front" || move === "back") {
    const rest = order.filter((id) => !isTarget.has(id));
    const reordered =
      move === "front" ? [...rest, ...targets] : [...targets, ...rest];
    return sameOrder(reordered, order) ? null : reordered;
  }

  const next = [...order];

  // One step at a time, walked from the end the selection is travelling toward.
  // Walking the other way would let the first selected object move and then be
  // immediately blocked by the second one still sitting where it started, so a
  // multi-selection would advance by less than one step.
  if (move === "forward") {
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (!isTarget.has(next[index]!)) continue;
      // Skip over other selected objects: they are moving too, so they are not
      // an obstacle, and landing above them would invert the selection.
      let above = index + 1;
      while (above < next.length && isTarget.has(next[above]!)) above += 1;
      if (above >= next.length) continue;
      const [moved] = next.splice(index, 1);
      next.splice(above, 0, moved!);
    }
  } else {
    for (let index = 0; index < next.length; index += 1) {
      if (!isTarget.has(next[index]!)) continue;
      let below = index - 1;
      while (below >= 0 && isTarget.has(next[below]!)) below -= 1;
      if (below < 0) continue;
      const [moved] = next.splice(index, 1);
      next.splice(below, 0, moved!);
    }
  }

  return sameOrder(next, order) ? null : next;
}
