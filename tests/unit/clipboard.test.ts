import { beforeEach, describe, expect, it } from "vitest";

import { copyObjects, cutObjects, pasteObjects } from "../../src/renderer/src/editor/clipboard";
import { PASTE_OFFSET, createObject, identityTransform } from "../../src/renderer/src/editor/factories";
import { createEditorStore } from "../../src/renderer/src/state/editor-store";
import type { DiagramObject } from "../../src/renderer/src/document/model";

function shape(id: string, x = 0, y = 0): DiagramObject {
  return { ...createObject("rectangle", identityTransform(x, y, 100, 50)), id };
}

describe("copyObjects", () => {
  const objects = [shape("a", 0, 0), shape("b", 10, 10), shape("c", 20, 20)];

  it("returns nothing for an empty selection", () => {
    expect(copyObjects(objects, [])).toEqual([]);
  });

  it("assigns fresh ids so a paste cannot collide with the original", () => {
    const payload = copyObjects(objects, ["a"]);
    expect(payload).toHaveLength(1);
    expect(payload[0]?.id).not.toBe("a");
  });

  it("copies without offsetting, leaving the cascade to paste", () => {
    const payload = copyObjects(objects, ["b"]);
    expect(payload[0]?.transform.x).toBe(10);
    expect(payload[0]?.transform.y).toBe(10);
  });

  it("preserves document order rather than selection order", () => {
    const payload = copyObjects(objects, ["c", "a"]);
    expect(payload.map((object) => object.transform.x)).toEqual([0, 20]);
  });

  it("ignores ids that are not in the document", () => {
    expect(copyObjects(objects, ["a", "missing"])).toHaveLength(1);
  });

  it("detaches the payload so later edits to the original do not leak through", () => {
    const payload = copyObjects(objects, ["a"]);
    objects[0]!.transform.x = 999;
    objects[0]!.style.strokeWidth = 42;
    expect(payload[0]?.transform.x).toBe(0);
    expect(payload[0]?.style.strokeWidth).not.toBe(42);
  });
});

describe("pasteObjects", () => {
  const clipboard = copyObjects([shape("a", 100, 100)], ["a"]);

  it("returns nothing for an empty clipboard", () => {
    expect(pasteObjects([], 1)).toEqual([]);
  });

  it("offsets by the step so repeated pastes cascade instead of stacking", () => {
    const first = pasteObjects(clipboard, 1);
    const second = pasteObjects(clipboard, 2);
    expect(first[0]?.transform.x).toBe(100 + PASTE_OFFSET.x);
    expect(second[0]?.transform.x).toBe(100 + PASTE_OFFSET.x * 2);
  });

  it("generates new ids on every paste", () => {
    const first = pasteObjects(clipboard, 1);
    const second = pasteObjects(clipboard, 1);
    expect(first[0]?.id).not.toBe(second[0]?.id);
    expect(first[0]?.id).not.toBe(clipboard[0]?.id);
  });

  it("treats a non-positive step as one so a paste never lands under the original", () => {
    expect(pasteObjects(clipboard, 0)[0]?.transform.x).toBe(100 + PASTE_OFFSET.x);
    expect(pasteObjects(clipboard, -3)[0]?.transform.x).toBe(100 + PASTE_OFFSET.x);
  });

  it("does not mutate the clipboard, so it can be pasted repeatedly", () => {
    pasteObjects(clipboard, 1);
    pasteObjects(clipboard, 2);
    expect(clipboard[0]?.transform.x).toBe(100);
  });
});

describe("cutObjects", () => {
  it("captures the payload before the delete can run", () => {
    const objects = [shape("a"), shape("b")];
    const { payload, ids } = cutObjects(objects, ["a", "b"]);
    expect(payload).toHaveLength(2);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("editor store clipboard state", () => {
  let store: ReturnType<typeof createEditorStore>;

  beforeEach(() => {
    store = createEditorStore();
  });

  it("starts empty with no cascade", () => {
    expect(store.getState().clipboard).toEqual([]);
    expect(store.getState().pasteStep).toBe(0);
  });

  it("resets the cascade when a new copy replaces the clipboard", () => {
    store.getState().nextPasteStep();
    store.getState().nextPasteStep();
    expect(store.getState().pasteStep).toBe(2);

    store.getState().setClipboard([shape("a")]);
    expect(store.getState().pasteStep).toBe(0);
    expect(store.getState().clipboard).toHaveLength(1);
  });

  it("advances the cascade on each paste step", () => {
    expect(store.getState().nextPasteStep()).toBe(1);
    expect(store.getState().nextPasteStep()).toBe(2);
    expect(store.getState().nextPasteStep()).toBe(3);
  });

  it("stores a copy of the payload, not the caller's array", () => {
    const payload = [shape("a")];
    store.getState().setClipboard(payload);
    payload.push(shape("b"));
    expect(store.getState().clipboard).toHaveLength(1);
  });
});
