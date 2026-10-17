import { describe, expect, it } from "vitest";

import {
  reorderIds,
  zOrderLabel,
  type ZOrderMove,
} from "../../src/renderer/src/editor/z-order";
import { ReorderObjectsCommand } from "../../src/renderer/src/editor/commands/object-commands";
import {
  createObject,
  identityTransform,
} from "../../src/renderer/src/editor/factories";
import { createDocumentStore } from "../../src/renderer/src/state/document-store";
import { createHistoryStore } from "../../src/renderer/src/state/history-store";
import type { DiagramObject } from "../../src/renderer/src/document/model";

/**
 * Later in the array is higher in the stack, matching SVG paint order. The tests
 * read "front" as the end of the list for that reason.
 */
const ORDER = ["a", "b", "c", "d"];

const ALL_MOVES: readonly ZOrderMove[] = [
  "front",
  "back",
  "forward",
  "backward",
];

function makeObject(id: string): DiagramObject {
  return {
    ...createObject("rectangle", identityTransform(0, 0, 100, 50)),
    id,
  };
}

function storeWith(ids: readonly string[]) {
  const store = createDocumentStore();
  store.getState().insertObjects(ids.map(makeObject));
  return store;
}

function objectsOf(
  store: ReturnType<typeof createDocumentStore>,
): DiagramObject[] {
  const { document, activePageId } = store.getState();
  return document.pages.find((page) => page.id === activePageId)?.objects ?? [];
}

function orderOf(store: ReturnType<typeof createDocumentStore>): string[] {
  return objectsOf(store).map((object) => object.id);
}

describe("reorderIds — single object", () => {
  it("moves an object to the top of the stack", () => {
    expect(reorderIds(ORDER, ["a"], "front")).toEqual(["b", "c", "d", "a"]);
  });

  it("moves an object to the bottom of the stack", () => {
    expect(reorderIds(ORDER, ["d"], "back")).toEqual(["d", "a", "b", "c"]);
  });

  it("steps an object up past its single neighbour", () => {
    expect(reorderIds(ORDER, ["a"], "forward")).toEqual(["b", "a", "c", "d"]);
  });

  it("steps an object down past its single neighbour", () => {
    expect(reorderIds(ORDER, ["d"], "backward")).toEqual(["a", "b", "d", "c"]);
  });
});

describe("reorderIds — multi-selection", () => {
  it("moves a selection forward as one block, keeping its internal order", () => {
    expect(reorderIds(ORDER, ["a", "b"], "forward")).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("moves a selection backward as one block, keeping its internal order", () => {
    expect(reorderIds(ORDER, ["c", "d"], "backward")).toEqual([
      "a",
      "c",
      "d",
      "b",
    ]);
  });

  it("preserves stack order rather than selection order when jumping to front", () => {
    expect(reorderIds(ORDER, ["c", "a"], "front")).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("leaves a blocked member in place instead of wrapping it to the other end", () => {
    // "d" is already topmost and cannot rise, but that must not stop "a".
    expect(reorderIds(ORDER, ["a", "d"], "forward")).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });
});

describe("reorderIds — no-ops report null", () => {
  it("returns null when the topmost object is already at the front", () => {
    expect(reorderIds(ORDER, ["d"], "front")).toBeNull();
    expect(reorderIds(ORDER, ["d"], "forward")).toBeNull();
  });

  it("returns null when the bottom object is already at the back", () => {
    expect(reorderIds(ORDER, ["a"], "back")).toBeNull();
    expect(reorderIds(ORDER, ["a"], "backward")).toBeNull();
  });

  it("returns null when a whole selection is already packed at the front", () => {
    expect(reorderIds(ORDER, ["c", "d"], "front")).toBeNull();
  });

  it("returns null for an empty or entirely unknown selection", () => {
    expect(reorderIds(ORDER, [], "front")).toBeNull();
    expect(reorderIds(ORDER, ["missing"], "forward")).toBeNull();
  });
});

describe("reorderIds — invariants", () => {
  it("drops unknown ids without losing the ones that do exist", () => {
    expect(reorderIds(ORDER, ["missing", "a"], "front")).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  it("always yields a permutation: nothing added, dropped or duplicated", () => {
    const selections: readonly (readonly string[])[] = [
      ["a"],
      ["d"],
      ["a", "c"],
      ["b", "c", "d"],
      ORDER,
    ];
    for (const move of ALL_MOVES) {
      for (const ids of selections) {
        const result = reorderIds(ORDER, ids, move);
        if (result === null) continue;
        expect(result).toHaveLength(ORDER.length);
        expect([...result].sort()).toEqual([...ORDER].sort());
      }
    }
  });

  it("does not mutate the order it was given", () => {
    const input = [...ORDER];
    reorderIds(input, ["a"], "front");
    reorderIds(input, ["a", "b"], "backward");
    expect(input).toEqual(ORDER);
  });
});

describe("zOrderLabel", () => {
  it("names every move so buttons and history entries agree", () => {
    expect(zOrderLabel("front")).toBe("Bring to front");
    expect(zOrderLabel("back")).toBe("Send to back");
    expect(zOrderLabel("forward")).toBe("Bring forward");
    expect(zOrderLabel("backward")).toBe("Send backward");
  });
});

describe("document store order mutators", () => {
  it("exposes the paint order for commands to capture", () => {
    const store = storeWith(ORDER);
    expect(store.getState().getObjectOrder()).toEqual(ORDER);
  });

  it("rearranges objects to match a supplied order", () => {
    const store = storeWith(ORDER);
    store.getState().setObjectOrder(["d", "c", "b", "a"]);
    expect(orderOf(store)).toEqual(["d", "c", "b", "a"]);
  });

  it("keeps unmentioned objects instead of dropping them from the document", () => {
    const store = storeWith(ORDER);
    store.getState().setObjectOrder(["c", "a"]);
    expect(orderOf(store).slice(0, 2)).toEqual(["c", "a"]);
    expect([...orderOf(store)].sort()).toEqual([...ORDER].sort());
  });

  it("ignores an empty order rather than clearing the page", () => {
    const store = storeWith(ORDER);
    // insertObjects already dirtied the document, so clean it first: the point
    // is that an ignored reorder does not dirty it again.
    store.getState().markClean();
    store.getState().setObjectOrder([]);
    expect(orderOf(store)).toEqual(ORDER);
    expect(store.getState().isDirty).toBe(false);
  });

  it("keeps zIndex a mirror of array position after a reorder", () => {
    const store = storeWith(ORDER);
    store.getState().setObjectOrder(["d", "c", "b", "a"]);
    expect(objectsOf(store).map((object) => object.zIndex)).toEqual([
      0, 1, 2, 3,
    ]);
  });
});

describe("ReorderObjectsCommand", () => {
  it("reorders on execute and restores the exact order on undo", () => {
    const store = storeWith(ORDER);
    const command = new ReorderObjectsCommand(store.getState(), ["a"], "front");

    command.execute();
    expect(orderOf(store)).toEqual(["b", "c", "d", "a"]);

    command.undo();
    expect(orderOf(store)).toEqual(ORDER);
  });

  it("is idempotent when execute and undo are each called twice", () => {
    const store = storeWith(ORDER);
    const command = new ReorderObjectsCommand(store.getState(), ["b"], "front");

    command.execute();
    command.execute();
    expect(orderOf(store)).toEqual(["a", "c", "d", "b"]);

    command.undo();
    command.undo();
    expect(orderOf(store)).toEqual(ORDER);
  });

  it("flags a no-op so the caller can keep it out of the history", () => {
    const store = storeWith(ORDER);
    expect(
      new ReorderObjectsCommand(store.getState(), ["d"], "front").isNoOp,
    ).toBe(true);
    expect(
      new ReorderObjectsCommand(store.getState(), ["a"], "front").isNoOp,
    ).toBe(false);
  });

  it("changes nothing when a no-op is executed anyway", () => {
    const store = storeWith(ORDER);
    new ReorderObjectsCommand(store.getState(), ["d"], "front").execute();
    expect(orderOf(store)).toEqual(ORDER);
  });

  it("labels itself with the same string the rail button shows", () => {
    const store = storeWith(ORDER);
    const command = new ReorderObjectsCommand(store.getState(), ["a"], "back");
    expect(command.label).toBe(zOrderLabel("back"));
  });

  it("round-trips through undo and redo in the history store", () => {
    const store = storeWith(ORDER);
    const history = createHistoryStore();

    history
      .getState()
      .execute(new ReorderObjectsCommand(store.getState(), ["a"], "front"));
    expect(orderOf(store)).toEqual(["b", "c", "d", "a"]);

    history.getState().undo();
    expect(orderOf(store)).toEqual(ORDER);

    history.getState().redo();
    expect(orderOf(store)).toEqual(["b", "c", "d", "a"]);
  });

  it("does not coalesce, so each press is its own undo step", () => {
    const store = storeWith(ORDER);
    const history = createHistoryStore();

    history
      .getState()
      .execute(new ReorderObjectsCommand(store.getState(), ["a"], "forward"));
    history
      .getState()
      .execute(new ReorderObjectsCommand(store.getState(), ["a"], "forward"));

    expect(history.getState().past).toHaveLength(2);
    history.getState().undo();
    expect(orderOf(store)).toEqual(["b", "a", "c", "d"]);
    history.getState().undo();
    expect(orderOf(store)).toEqual(ORDER);
  });

  it("restores a multi-selection block exactly on undo", () => {
    const store = storeWith(["a", "b", "c", "d", "e"]);
    const command = new ReorderObjectsCommand(
      store.getState(),
      ["a", "b"],
      "forward",
    );

    command.execute();
    expect(orderOf(store)).toEqual(["c", "a", "b", "d", "e"]);

    command.undo();
    expect(orderOf(store)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
