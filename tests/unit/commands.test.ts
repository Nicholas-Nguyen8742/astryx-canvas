import { beforeEach, describe, expect, it } from "vitest";

import {
  CreateConnectorsCommand,
  CreateObjectsCommand,
  DeleteConnectorsCommand,
  DeleteObjectsCommand,
  MoveObjectsCommand,
  ResizeObjectCommand,
  RewireConnectorCommand,
  UpdateConnectorLabelCommand,
  UpdateContentCommand,
  UpdateStyleCommand,
} from "../../src/renderer/src/editor/commands/object-commands";
import {
  createConnector,
  createObject,
  identityTransform,
} from "../../src/renderer/src/editor/factories";
import { createDocumentStore } from "../../src/renderer/src/state/document-store";
import {
  MAX_HISTORY,
  createHistoryStore,
} from "../../src/renderer/src/state/history-store";
import type {
  Connector,
  DiagramObject,
  Transform,
} from "../../src/renderer/src/document/model";

function makeObject(id: string, x = 0, y = 0): DiagramObject {
  const object = createObject("rectangle", identityTransform(x, y, 100, 50));
  return { ...object, id };
}

function transformAt(
  x: number,
  y: number,
  width = 100,
  height = 50,
): Transform {
  return identityTransform(x, y, width, height);
}

function objectsOf(
  store: ReturnType<typeof createDocumentStore>,
): DiagramObject[] {
  const { document, activePageId } = store.getState();
  return document.pages.find((page) => page.id === activePageId)?.objects ?? [];
}

describe("document store mutators", () => {
  it("inserts objects and keeps zIndex a mirror of array order", () => {
    const store = createDocumentStore();
    store
      .getState()
      .insertObjects([makeObject("a"), makeObject("b"), makeObject("c")]);
    expect(objectsOf(store).map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(objectsOf(store).map((o) => o.zIndex)).toEqual([0, 1, 2]);
  });

  it("extracts objects with their original index and restores them in place", () => {
    const store = createDocumentStore();
    store
      .getState()
      .insertObjects([makeObject("a"), makeObject("b"), makeObject("c")]);

    const extracted = store.getState().extractObjects(["b"]);
    expect(objectsOf(store).map((o) => o.id)).toEqual(["a", "c"]);
    expect(extracted.map((e) => e.index)).toEqual([1]);

    store.getState().restoreObjects(extracted);
    expect(objectsOf(store).map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("marks the document dirty on mutation and clean on request", () => {
    const store = createDocumentStore();
    expect(store.getState().isDirty).toBe(false);
    store.getState().insertObjects([makeObject("a")]);
    expect(store.getState().isDirty).toBe(true);
    store.getState().markClean();
    expect(store.getState().isDirty).toBe(false);
  });

  it("reindexes after a delete so zIndex never disagrees with order", () => {
    const store = createDocumentStore();
    store
      .getState()
      .insertObjects([makeObject("a"), makeObject("b"), makeObject("c")]);
    store.getState().extractObjects(["a"]);
    expect(objectsOf(store).map((o) => o.zIndex)).toEqual([0, 1]);
  });

  it("ignores empty mutations", () => {
    const store = createDocumentStore();
    store.getState().insertObjects([]);
    store.getState().restoreObjects([]);
    expect(objectsOf(store)).toEqual([]);
    expect(store.getState().isDirty).toBe(false);
  });
});

describe("object commands", () => {
  let store: ReturnType<typeof createDocumentStore>;

  beforeEach(() => {
    store = createDocumentStore();
  });

  it("CreateObjectsCommand inserts on execute and removes on undo", () => {
    const objects = [makeObject("a"), makeObject("b")];
    const command = new CreateObjectsCommand(store.getState(), objects);

    command.execute();
    expect(objectsOf(store).map((o) => o.id)).toEqual(["a", "b"]);

    command.undo();
    expect(objectsOf(store)).toEqual([]);
  });

  it("DeleteObjectsCommand restores objects to their original z-position", () => {
    store
      .getState()
      .insertObjects([makeObject("a"), makeObject("b"), makeObject("c")]);
    const command = new DeleteObjectsCommand(store.getState(), ["b"]);

    command.execute();
    expect(objectsOf(store).map((o) => o.id)).toEqual(["a", "c"]);

    command.undo();
    // Must come back between a and c, not appended on top.
    expect(objectsOf(store).map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("DeleteObjectsCommand is replayable: execute, undo, execute again", () => {
    store.getState().insertObjects([makeObject("a"), makeObject("b")]);
    const command = new DeleteObjectsCommand(store.getState(), ["a"]);

    command.execute();
    command.undo();
    command.execute();
    expect(objectsOf(store).map((o) => o.id)).toEqual(["b"]);
  });

  it("MoveObjectsCommand swaps between the captured transforms", () => {
    store.getState().insertObjects([makeObject("a", 0, 0)]);
    const command = new MoveObjectsCommand(
      store.getState(),
      ["a"],
      { a: transformAt(0, 0) },
      { a: transformAt(80, 40) },
    );

    command.execute();
    expect(objectsOf(store)[0]?.transform).toMatchObject({ x: 80, y: 40 });

    command.undo();
    expect(objectsOf(store)[0]?.transform).toMatchObject({ x: 0, y: 0 });
  });

  it("ResizeObjectCommand restores the original size", () => {
    store.getState().insertObjects([makeObject("a")]);
    const command = new ResizeObjectCommand(
      store.getState(),
      ["a"],
      { a: transformAt(0, 0, 100, 50) },
      { a: transformAt(0, 0, 240, 120) },
    );

    command.execute();
    expect(objectsOf(store)[0]?.transform).toMatchObject({
      width: 240,
      height: 120,
    });
    command.undo();
    expect(objectsOf(store)[0]?.transform).toMatchObject({
      width: 100,
      height: 50,
    });
  });

  it("UpdateStyleCommand restores the previous style", () => {
    store.getState().insertObjects([makeObject("a")]);
    const before = store.getState().getStyles(["a"]).a!;
    const command = new UpdateStyleCommand(
      store.getState(),
      ["a"],
      { a: before },
      {
        a: { ...before, strokeWidth: 9 },
      },
    );

    command.execute();
    expect(store.getState().getStyles(["a"]).a?.strokeWidth).toBe(9);
    command.undo();
    expect(store.getState().getStyles(["a"]).a?.strokeWidth).toBe(
      before.strokeWidth,
    );
  });

  it("UpdateContentCommand restores the previous label", () => {
    const text: DiagramObject = {
      ...makeObject("label"),
      type: "text",
      content: { value: "Before" },
    };
    store.getState().insertObjects([text]);

    const from = store.getState().getContents(["label"]);
    const command = new UpdateContentCommand(
      store.getState(),
      ["label"],
      from,
      {
        label: { value: "After" },
      },
    );

    command.execute();
    expect(store.getState().getContents(["label"]).label?.value).toBe("After");
    command.undo();
    expect(store.getState().getContents(["label"]).label?.value).toBe("Before");
  });

  it("UpdateContentCommand clears a label on an explicit undefined", () => {
    const text: DiagramObject = {
      ...makeObject("label"),
      type: "text",
      content: { value: "Before" },
    };
    store.getState().insertObjects([text]);

    const from = store.getState().getContents(["label"]);
    const command = new UpdateContentCommand(
      store.getState(),
      ["label"],
      from,
      {
        label: undefined,
      },
    );

    command.execute();
    // Clearing a label and leaving it untouched must be different operations.
    expect(store.getState().getContents(["label"]).label).toBeUndefined();
    command.undo();
    expect(store.getState().getContents(["label"]).label?.value).toBe("Before");
  });

  it("coalesces consecutive label edits so typing is a single undo step", () => {
    const text: DiagramObject = {
      ...makeObject("label"),
      type: "text",
      content: { value: "" },
    };
    store.getState().insertObjects([text]);

    const first = new UpdateContentCommand(
      store.getState(),
      ["label"],
      { label: { value: "" } },
      { label: { value: "A" } },
    );
    const second = new UpdateContentCommand(
      store.getState(),
      ["label"],
      { label: { value: "A" } },
      { label: { value: "AB" } },
    );

    expect(second.merge(first)).toBe(true);
    first.execute();
    expect(store.getState().getContents(["label"]).label?.value).toBe("AB");
    // One undo returns to the pre-typing label, not one keystroke back.
    first.undo();
    expect(store.getState().getContents(["label"]).label?.value).toBe("");
  });

  it("labels commands with a user-facing count for the Edit menu", () => {
    expect(
      new CreateObjectsCommand(store.getState(), [makeObject("a")]).label,
    ).toBe("Create object");
    expect(
      new DeleteObjectsCommand(store.getState(), ["a", "b", "c"]).label,
    ).toBe("Delete 3 objects");
  });
});

describe("command coalescing", () => {
  let store: ReturnType<typeof createDocumentStore>;

  beforeEach(() => {
    store = createDocumentStore();
    store.getState().insertObjects([makeObject("a")]);
  });

  it("folds a second move of the same objects into the first", () => {
    const first = new MoveObjectsCommand(
      store.getState(),
      ["a"],
      { a: transformAt(0, 0) },
      { a: transformAt(10, 0) },
    );
    const second = new MoveObjectsCommand(
      store.getState(),
      ["a"],
      { a: transformAt(10, 0) },
      { a: transformAt(25, 0) },
    );

    expect(second.merge(first)).toBe(true);
    first.undo();
    // One undo returns to the pre-gesture position, not the midpoint.
    expect(objectsOf(store)[0]?.transform.x).toBe(0);
  });

  it("does not fold moves of different objects together", () => {
    store.getState().insertObjects([makeObject("b")]);
    const moveA = new MoveObjectsCommand(
      store.getState(),
      ["a"],
      { a: transformAt(0, 0) },
      { a: transformAt(10, 0) },
    );
    const moveB = new MoveObjectsCommand(
      store.getState(),
      ["b"],
      { b: transformAt(0, 0) },
      { b: transformAt(10, 0) },
    );
    expect(moveB.merge(moveA)).toBe(false);
  });

  it("does not fold a resize into a move", () => {
    const move = new MoveObjectsCommand(
      store.getState(),
      ["a"],
      { a: transformAt(0, 0) },
      { a: transformAt(10, 0) },
    );
    const resize = new ResizeObjectCommand(
      store.getState(),
      ["a"],
      { a: transformAt(10, 0) },
      { a: transformAt(10, 0, 200, 50) },
    );
    expect(resize.merge(move)).toBe(false);
  });
});

describe("history store", () => {
  let store: ReturnType<typeof createDocumentStore>;
  let history: ReturnType<typeof createHistoryStore>;

  beforeEach(() => {
    store = createDocumentStore();
    history = createHistoryStore();
  });

  function moveCommand(to: number): MoveObjectsCommand {
    return new MoveObjectsCommand(
      store.getState(),
      ["a"],
      { a: transformAt(0, 0) },
      { a: transformAt(to, 0) },
    );
  }

  it("executes then undoes and redoes in order", () => {
    store.getState().insertObjects([makeObject("a")]);
    history
      .getState()
      .execute(new CreateObjectsCommand(store.getState(), [makeObject("b")]));
    expect(objectsOf(store).map((o) => o.id)).toContain("b");

    history.getState().undo();
    expect(objectsOf(store).map((o) => o.id)).not.toContain("b");

    history.getState().redo();
    expect(objectsOf(store).map((o) => o.id)).toContain("b");
  });

  it("does nothing when undoing or redoing an empty stack", () => {
    expect(() => history.getState().undo()).not.toThrow();
    expect(() => history.getState().redo()).not.toThrow();
    expect(history.getState().past).toEqual([]);
    expect(history.getState().future).toEqual([]);
  });

  it("discards the redo stack when a new command is executed after an undo", () => {
    store.getState().insertObjects([makeObject("a")]);
    history.getState().execute(moveCommand(10));
    history.getState().execute(moveCommand(20));
    history.getState().undo();
    expect(history.getState().future).toHaveLength(1);

    history.getState().execute(moveCommand(99));
    expect(history.getState().future).toHaveLength(0);
  });

  it("commit records an already-applied command without running it again", () => {
    let executions = 0;
    let undos = 0;

    history.getState().commit({
      id: "already-applied",
      label: "Already applied",
      timestamp: new Date().toISOString(),
      execute: () => {
        executions += 1;
      },
      undo: () => {
        undos += 1;
      },
    });

    // The whole point of commit: the gesture already happened on screen, so
    // replaying it would double the movement.
    expect(executions).toBe(0);
    expect(history.getState().past).toHaveLength(1);

    history.getState().undo();
    expect(undos).toBe(1);
  });

  it("coalesces consecutive moves into a single undo entry", () => {
    store.getState().insertObjects([makeObject("a")]);
    for (const x of [5, 10, 15, 20]) {
      history.getState().execute(moveCommand(x));
    }
    expect(history.getState().past).toHaveLength(1);
    expect(objectsOf(store)[0]?.transform.x).toBe(20);

    history.getState().undo();
    expect(objectsOf(store)[0]?.transform.x).toBe(0);
  });

  it("retains at least the 100 undo steps FR-HIST-02 requires", () => {
    expect(MAX_HISTORY).toBeGreaterThanOrEqual(100);
  });

  it("trims the oldest entries past the limit", () => {
    const limit = 5;
    const bounded = createHistoryStore(limit);
    for (let index = 0; index < limit + 20; index += 1) {
      bounded.getState().execute({
        id: `noop_${index}`,
        label: "noop",
        timestamp: new Date().toISOString(),
        execute: () => undefined,
        undo: () => undefined,
      });
    }
    expect(bounded.getState().past).toHaveLength(limit);
    expect(bounded.getState().past[0]?.id).toBe("noop_20");
  });

  it("clear empties both stacks", () => {
    store.getState().insertObjects([makeObject("a")]);
    history.getState().execute(moveCommand(10));
    history.getState().undo();
    history.getState().clear();
    expect(history.getState().past).toEqual([]);
    expect(history.getState().future).toEqual([]);
  });
});

describe("connectors", () => {
  function makeConnector(
    id: string,
    source: string,
    target: string,
  ): Connector {
    return {
      ...createConnector({ objectId: source }, { objectId: target }),
      id,
    };
  }

  function connectorIds(
    store: ReturnType<typeof createDocumentStore>,
  ): string[] {
    return store
      .getState()
      .getConnectors()
      .map((entry) => entry.id);
  }

  /**
   * Three shapes wired a->b, b->c and a->c, so every delete has a distinct set
   * of connectors it should take with it and one it should leave alone.
   */
  function wiredStore() {
    const store = createDocumentStore();
    store
      .getState()
      .insertObjects([makeObject("a"), makeObject("b"), makeObject("c")]);
    store
      .getState()
      .insertConnectors([
        makeConnector("conn1", "a", "b"),
        makeConnector("conn2", "b", "c"),
        makeConnector("conn3", "a", "c"),
      ]);
    return store;
  }

  describe("document state", () => {
    it("inserts connectors and keeps zIndex a mirror of array order", () => {
      const store = wiredStore();
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
      expect(
        store
          .getState()
          .getConnectors()
          .map((entry) => entry.zIndex),
      ).toEqual([0, 1, 2]);
    });

    it("extracts a connector with its index and restores it in place", () => {
      const store = wiredStore();
      const extracted = store.getState().extractConnectors(["conn2"]);
      expect(connectorIds(store)).toEqual(["conn1", "conn3"]);
      expect(extracted.map((entry) => entry.index)).toEqual([1]);

      store.getState().restoreConnectors(extracted);
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
    });

    it("restores several connectors to their original positions, not on top", () => {
      const store = wiredStore();
      const extracted = store.getState().extractConnectors(["conn1", "conn3"]);
      expect(connectorIds(store)).toEqual(["conn2"]);

      store.getState().restoreConnectors(extracted);
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
    });

    it("returns a copy from getConnectors so callers cannot reorder the store", () => {
      const store = wiredStore();
      store.getState().getConnectors().reverse();
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
    });

    it("ignores empty connector mutations", () => {
      const store = wiredStore();
      store.getState().markClean();
      store.getState().insertConnectors([]);
      store.getState().restoreConnectors([]);
      expect(connectorIds(store)).toHaveLength(3);
      expect(store.getState().isDirty).toBe(false);
    });

    it("marks the document dirty on a connector mutation", () => {
      const store = createDocumentStore();
      expect(store.getState().isDirty).toBe(false);
      store.getState().insertConnectors([makeConnector("conn1", "a", "b")]);
      expect(store.getState().isDirty).toBe(true);
    });

    it("matches a connector attached at either end", () => {
      const store = wiredStore();
      expect(store.getState().connectorsTouching(["a"]).sort()).toEqual([
        "conn1",
        "conn3",
      ]);
      expect(store.getState().connectorsTouching(["b"]).sort()).toEqual([
        "conn1",
        "conn2",
      ]);
      expect(store.getState().connectorsTouching(["c"]).sort()).toEqual([
        "conn2",
        "conn3",
      ]);
    });

    it("reports nothing for an object that has no connectors", () => {
      const store = wiredStore();
      store.getState().insertObjects([makeObject("d")]);
      expect(store.getState().connectorsTouching(["d"])).toEqual([]);
    });

    it("lists a connector once when both of its ends are being deleted", () => {
      const store = wiredStore();
      const touching = store.getState().connectorsTouching(["a", "b"]);
      expect(touching.filter((id) => id === "conn1")).toHaveLength(1);
      expect(touching.sort()).toEqual(["conn1", "conn2", "conn3"]);
    });
  });

  describe("commands", () => {
    it("creates a connector and removes it on undo", () => {
      const store = createDocumentStore();
      store.getState().insertObjects([makeObject("a"), makeObject("b")]);
      const command = new CreateConnectorsCommand(store.getState(), [
        makeConnector("conn1", "a", "b"),
      ]);

      expect(command.label).toBe("Create connector");
      command.execute();
      expect(connectorIds(store)).toEqual(["conn1"]);

      command.undo();
      expect(connectorIds(store)).toEqual([]);
    });

    it("pluralises the create label", () => {
      const store = createDocumentStore();
      const command = new CreateConnectorsCommand(store.getState(), [
        makeConnector("c1", "a", "b"),
        makeConnector("c2", "b", "c"),
      ]);
      expect(command.label).toBe("Create 2 connectors");
    });

    it("deletes a connector and restores it at its original index", () => {
      const store = wiredStore();
      const command = new DeleteConnectorsCommand(store.getState(), ["conn2"]);
      expect(command.label).toBe("Delete connector");

      command.execute();
      expect(connectorIds(store)).toEqual(["conn1", "conn3"]);

      command.undo();
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
    });

    it("round-trips through undo and redo in the history store", () => {
      const store = wiredStore();
      const history = createHistoryStore();

      history
        .getState()
        .execute(new DeleteConnectorsCommand(store.getState(), ["conn1"]));
      expect(connectorIds(store)).toEqual(["conn2", "conn3"]);

      history.getState().undo();
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);

      history.getState().redo();
      expect(connectorIds(store)).toEqual(["conn2", "conn3"]);
    });
  });

  describe("deleting a shape takes its connectors with it", () => {
    it("removes only the connectors attached to the deleted object", () => {
      const store = wiredStore();
      new DeleteObjectsCommand(store.getState(), ["a"]).execute();

      expect(store.getState().getObjectOrder()).toEqual(["b", "c"]);
      expect(connectorIds(store)).toEqual(["conn2"]);
    });

    it("restores the shape and its connectors as one undo", () => {
      const store = wiredStore();
      const command = new DeleteObjectsCommand(store.getState(), ["a"]);
      command.execute();
      command.undo();

      expect(store.getState().getObjectOrder()).toEqual(["a", "b", "c"]);
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
    });

    it("leaves every connector alone when the deleted object has none", () => {
      const store = wiredStore();
      store.getState().insertObjects([makeObject("d")]);
      new DeleteObjectsCommand(store.getState(), ["d"]).execute();

      expect(store.getState().getObjectOrder()).toEqual(["a", "b", "c"]);
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
    });

    it("survives two sequential deletes, each undoable on its own", () => {
      const store = wiredStore();
      const history = createHistoryStore();

      history
        .getState()
        .execute(new DeleteObjectsCommand(store.getState(), ["a"]));
      history
        .getState()
        .execute(new DeleteObjectsCommand(store.getState(), ["b"]));
      expect(connectorIds(store)).toEqual([]);
      expect(store.getState().getObjectOrder()).toEqual(["c"]);

      history.getState().undo();
      expect(connectorIds(store)).toEqual(["conn2"]);
      expect(store.getState().getObjectOrder()).toEqual(["b", "c"]);

      history.getState().undo();
      expect(connectorIds(store)).toEqual(["conn1", "conn2", "conn3"]);
      expect(store.getState().getObjectOrder()).toEqual(["a", "b", "c"]);
    });
  });

  describe("labels", () => {
    function labelOf(
      store: ReturnType<typeof createDocumentStore>,
      id: string,
    ): string | undefined {
      return store.getState().getConnectorLabels([id])[id]?.value;
    }

    it("sets a label and leaves the others untouched", () => {
      const store = wiredStore();
      store.getState().setConnectorLabels({ conn1: { value: "HTTPS" } });

      expect(labelOf(store, "conn1")).toBe("HTTPS");
      expect(
        store.getState().getConnectorLabels(["conn2"]).conn2,
      ).toBeUndefined();
    });

    it("removes a label when the entry is explicitly undefined", () => {
      const store = wiredStore();
      store.getState().setConnectorLabels({ conn1: { value: "HTTPS" } });
      // Key presence, not truthiness: an empty-string label would otherwise be
      // indistinguishable from "leave this one alone".
      store.getState().setConnectorLabels({ conn1: undefined });

      expect(
        store.getState().getConnectorLabels(["conn1"]).conn1,
      ).toBeUndefined();
    });

    it("edits a label through the command and undoes it", () => {
      const store = wiredStore();
      const from = store.getState().getConnectorLabels(["conn1"]);
      const command = new UpdateConnectorLabelCommand(
        store.getState(),
        ["conn1"],
        from,
        { conn1: { value: "HTTPS" } },
      );

      expect(command.label).toBe("Edit connector label");
      command.execute();
      expect(labelOf(store, "conn1")).toBe("HTTPS");

      command.undo();
      expect(
        store.getState().getConnectorLabels(["conn1"]).conn1,
      ).toBeUndefined();
    });

    it("coalesces typing into a single undo step", () => {
      const store = wiredStore();
      const history = createHistoryStore();
      // Captured once, before typing: that is what makes one undo return to the
      // original label rather than one keystroke back.
      const from = store.getState().getConnectorLabels(["conn1"]);

      for (const value of ["H", "HT", "HTT", "HTTP", "HTTPS"]) {
        history.getState().execute(
          new UpdateConnectorLabelCommand(store.getState(), ["conn1"], from, {
            conn1: { value },
          }),
        );
      }

      expect(history.getState().past).toHaveLength(1);
      expect(labelOf(store, "conn1")).toBe("HTTPS");

      history.getState().undo();
      expect(
        store.getState().getConnectorLabels(["conn1"]).conn1,
      ).toBeUndefined();
    });

    it("does not coalesce edits to two different connectors", () => {
      const store = wiredStore();
      const history = createHistoryStore();

      // Each command snapshots its own target's prior label, exactly as the
      // canvas commit handler does. Passing an empty object instead would make
      // undo a silent no-op, because setConnectorLabels keys off presence rather
      // than truthiness and an absent key means "leave this one alone".
      history.getState().execute(
        new UpdateConnectorLabelCommand(
          store.getState(),
          ["conn1"],
          store.getState().getConnectorLabels(["conn1"]),
          {
            conn1: { value: "HTTPS" },
          },
        ),
      );
      history.getState().execute(
        new UpdateConnectorLabelCommand(
          store.getState(),
          ["conn2"],
          store.getState().getConnectorLabels(["conn2"]),
          {
            conn2: { value: "gRPC" },
          },
        ),
      );

      expect(history.getState().past).toHaveLength(2);
      expect(labelOf(store, "conn1")).toBe("HTTPS");
      expect(labelOf(store, "conn2")).toBe("gRPC");

      // Each edit undoes on its own, and neither disturbs the other's label.
      history.getState().undo();
      expect(labelOf(store, "conn1")).toBe("HTTPS");
      expect(labelOf(store, "conn2")).toBeUndefined();
    });

    it("does not coalesce into an unrelated command", () => {
      const store = wiredStore();
      const history = createHistoryStore();
      const from = store.getState().getConnectorLabels(["conn1"]);

      history.getState().execute(
        new UpdateConnectorLabelCommand(store.getState(), ["conn1"], from, {
          conn1: { value: "HTTPS" },
        }),
      );
      history
        .getState()
        .execute(new DeleteConnectorsCommand(store.getState(), ["conn2"]));

      expect(history.getState().past).toHaveLength(2);
    });
  });

  describe("re-attaching endpoints", () => {
    function endpointsOf(
      store: ReturnType<typeof createDocumentStore>,
      id: string,
    ) {
      return store.getState().getConnectorEndpoints([id])[id];
    }

    it("reads back both ends of a connector", () => {
      const store = wiredStore();
      expect(endpointsOf(store, "conn1")).toEqual({
        source: { objectId: "a" },
        target: { objectId: "b" },
      });
    });

    it("replaces one end and leaves the other alone", () => {
      const store = wiredStore();
      store
        .getState()
        .setConnectorEndpoints({ conn1: { target: { objectId: "c" } } });

      expect(endpointsOf(store, "conn1")).toEqual({
        source: { objectId: "a" },
        target: { objectId: "c" },
      });
    });

    it("leaves connectors the entry does not name untouched", () => {
      const store = wiredStore();
      store
        .getState()
        .setConnectorEndpoints({ conn1: { source: { objectId: "c" } } });

      expect(endpointsOf(store, "conn2")).toEqual({
        source: { objectId: "b" },
        target: { objectId: "c" },
      });
    });

    it("keeps the connector's id and label through a rewire", () => {
      // The whole reason to rewire rather than delete and redraw: anything
      // referring to this connector, including its own label, stays valid.
      const store = wiredStore();
      store.getState().setConnectorLabels({ conn1: { value: "HTTPS" } });
      store.getState().setConnectorEndpoints({
        conn1: { target: { objectId: "c", portId: "n" } },
      });

      expect(connectorIds(store)).toContain("conn1");
      expect(store.getState().getConnectorLabels(["conn1"]).conn1?.value).toBe(
        "HTTPS",
      );
      expect(endpointsOf(store, "conn1")?.target).toEqual({
        objectId: "c",
        portId: "n",
      });
    });

    it("can move an end onto a specific port", () => {
      const store = wiredStore();
      store.getState().setConnectorEndpoints({
        conn1: { source: { objectId: "a", portId: "n" } },
      });
      expect(endpointsOf(store, "conn1")?.source).toEqual({
        objectId: "a",
        portId: "n",
      });
    });

    it("rewires through the command and undoes to the original pair", () => {
      const store = wiredStore();
      const from = endpointsOf(store, "conn1")!;
      const command = new RewireConnectorCommand(
        store.getState(),
        "conn1",
        from,
        { target: { objectId: "c" } },
      );

      expect(command.label).toBe("Reconnect");
      command.execute();
      expect(endpointsOf(store, "conn1")?.target).toEqual({ objectId: "c" });

      command.undo();
      expect(endpointsOf(store, "conn1")).toEqual(from);
    });

    it("does not coalesce, so two rewires are two undo steps", () => {
      const store = wiredStore();
      const history = createHistoryStore();

      history
        .getState()
        .execute(
          new RewireConnectorCommand(
            store.getState(),
            "conn1",
            endpointsOf(store, "conn1")!,
            { target: { objectId: "c" } },
          ),
        );
      history
        .getState()
        .execute(
          new RewireConnectorCommand(
            store.getState(),
            "conn1",
            endpointsOf(store, "conn1")!,
            { target: { objectId: "b" } },
          ),
        );

      expect(history.getState().past).toHaveLength(2);

      history.getState().undo();
      expect(endpointsOf(store, "conn1")?.target).toEqual({ objectId: "c" });
      history.getState().undo();
      expect(endpointsOf(store, "conn1")?.target).toEqual({ objectId: "b" });
    });
  });
});
