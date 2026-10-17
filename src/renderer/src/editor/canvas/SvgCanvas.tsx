import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type {
  ArrowType,
  Connector,
  ConnectorEndpoint,
  DiagramObject,
  Point,
  Transform,
} from "../../document/model";
import {
  intersects,
  nearestPort,
  objectBounds,
  portsOf,
  portWorldPoint,
  resizeTransform,
  screenToWorld,
  snapPoint,
  worldToScreen,
} from "../geometry";
import {
  createConnector,
  createObject,
  normaliseDragTransform,
  previewConnector,
  previewObject,
  type ShapeTool,
} from "../factories";
import {
  CreateConnectorsCommand,
  CreateObjectsCommand,
  DeleteConnectorsCommand,
  DeleteObjectsCommand,
  MoveObjectsCommand,
  ReorderObjectsCommand,
  ResizeObjectCommand,
  UpdateConnectorLabelCommand,
  UpdateContentCommand,
} from "../commands/object-commands";
import { copyObjects, pasteObjects } from "../clipboard";
import type { ZOrderMove } from "../z-order";
import { useDocumentStore } from "../../state/document-store";
import { useHistoryStore } from "../../state/history-store";
import {
  isShapeTool,
  useEditorStore,
  type ResizeHandle,
} from "../../state/editor-store";
import {
  ARROW_MARKER_BOX,
  ARROW_MARKER_SHAPES,
  CONNECTOR_LABEL_FONT_SIZE,
  arrowMarkerId,
  connectorAttrs,
  connectorLabelAttrs,
  shapeGeometry,
} from "./shape-attrs";
import {
  indexObjects,
  resolveConnector,
  resolveConnectors,
  type ResolvedConnector,
} from "../connectors";
import { TextEditorOverlay, type TextEditorTarget } from "./TextEditorOverlay";

/** Handle edge length in screen pixels, so handles stay grabbable at any zoom. */
const HANDLE_SCREEN_SIZE = 8;
/**
 * Port snap radius and drawn radius, both in screen pixels.
 *
 * Screen units divided by zoom at the point of use, never world units: a fixed
 * world tolerance would make ports impossible to hit when zoomed out and
 * enormous when zoomed in.
 */
const PORT_SNAP_SCREEN_PX = 12;
const PORT_HANDLE_SCREEN_R = 4;
/**
 * Width of the inline field for a connector label, in world units.
 *
 * A connector has no box of its own to size the field to, unlike a text object,
 * so this is a fixed editing affordance rather than something derived from the
 * document.
 */
const CONNECTOR_LABEL_FIELD_WIDTH = 160;
/** A line has no fill to click, so it gets an invisible constant-width hit stroke. */
const LINE_HIT_WIDTH = 12;
/** Arrow-key nudge step in world units; Shift multiplies it (FR-OBJ-14/15). */
const NUDGE_STEP = 1;
const NUDGE_STEP_COARSE = 10;
/** Below this on-screen spacing the grid is solid noise, so it is not drawn. */
const MIN_GRID_PITCH = 3;

const HANDLES: readonly ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

const NO_OBJECTS: readonly DiagramObject[] = [];

/** Stable empty reference, so the selector below cannot return a new array. */
const NO_CONNECTORS: readonly Connector[] = [];

const NUDGE_DELTAS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * Z-order bindings (FR-OBJ-11). Bracket keys, matching every other drawing tool,
 * with Shift for the absolute jumps to the front and back of the stack.
 *
 * Keyed on `event.code`, not `event.key`. Two reasons, both of which would
 * silently break the shifted half of the feature rather than fail visibly:
 * holding Shift makes a bracket key report `}` or `{` as its `key`, and on a
 * non-US layout the physical bracket keys report entirely different characters.
 * `code` identifies the physical key and is stable across both.
 */
const Z_ORDER_CODES: Record<
  string,
  { plain: ZOrderMove; shifted: ZOrderMove }
> = {
  BracketRight: { plain: "forward", shifted: "front" },
  BracketLeft: { plain: "backward", shifted: "back" },
};

function handleOffset(handle: ResizeHandle): Point {
  return {
    x: handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5,
    y: handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5,
  };
}

/**
 * Draws one document object.
 *
 * The same component renders committed objects and the in-progress drag preview
 * (`isPreview`), because both are real `DiagramObject`s passed through
 * `shapeGeometry`. That is what stops the preview from being a second,
 * simplified approximation of a shape that can drift from what the gesture
 * actually creates.
 */
function RenderedObject({
  object,
  isPreview = false,
}: {
  object: DiagramObject;
  isPreview?: boolean;
}) {
  const geometry = shapeGeometry(object, "dom");
  const common = {
    // A preview is not an object, so it must stay unresolvable to the
    // `data-object-id` hit testing that drives selection and inline editing.
    ...(isPreview ? {} : { "data-object-id": object.id }),
    ...(isPreview ? { className: "canvas-preview" } : {}),
    style: { pointerEvents: object.locked ? ("none" as const) : undefined },
  };

  if (geometry.element === "text") {
    const fontSize = Number(geometry.attrs["font-size"] ?? 14);
    return (
      <text {...geometry.attrs} {...common}>
        {(geometry.lines ?? []).map((line, index) => (
          <tspan
            key={index}
            x={geometry.attrs.x}
            dy={index === 0 ? 0 : fontSize * 1.2}
          >
            {line}
          </tspan>
        ))}
      </text>
    );
  }

  if (geometry.element === "line") {
    return (
      <g {...common}>
        {/* Wide transparent stroke underneath: a 2px line is otherwise almost
            impossible to click, and §14.2 requires connector hit testing. */}
        <line
          {...geometry.attrs}
          stroke="transparent"
          strokeWidth={LINE_HIT_WIDTH}
          vectorEffect="non-scaling-stroke"
        />
        <line {...geometry.attrs} vectorEffect="non-scaling-stroke" />
      </g>
    );
  }

  if (geometry.element === "ellipse") {
    return <ellipse {...geometry.attrs} {...common} />;
  }

  if (geometry.element === "polygon") {
    return <polygon {...geometry.attrs} {...common} />;
  }

  return <rect {...geometry.attrs} {...common} />;
}

/**
 * Draws one connector.
 *
 * Two paths sharing one `d`, as with lines and arrows: a wide transparent one
 * underneath so a 2px curve is actually clickable, and the visible one on top.
 * Sharing the geometry means a connector cannot be selectable somewhere it is
 * not drawn, which is the failure mode an independently-sized hit area produces.
 */
function RenderedConnector({
  connector,
  resolved,
}: {
  connector: Connector;
  resolved: ResolvedConnector;
}) {
  const attrs = connectorAttrs(connector, resolved, "dom");
  const label = connector.label?.value;
  return (
    <g
      data-connector-id={connector.id}
      style={{
        pointerEvents: connector.locked ? ("none" as const) : undefined,
      }}
    >
      <path
        {...attrs}
        stroke="transparent"
        strokeWidth={LINE_HIT_WIDTH}
        vectorEffect="non-scaling-stroke"
      />
      <path {...attrs} vectorEffect="non-scaling-stroke" />
      {connector.label && label ? (
        <text
          {...connectorLabelAttrs(
            connector.label,
            resolved,
            "dom",
            // The canvas backdrop rather than a literal white, so the halo knocks
            // the line out instead of painting a pale patch over a dark theme.
            "var(--color-background-body)",
          )}
          vectorEffect="non-scaling-stroke"
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

/**
 * Every arrowhead shape, defined unconditionally.
 *
 * The export writer emits only the markers a file actually references, because a
 * standalone SVG is a user-visible artefact and dead defs are noise. In memory
 * there is no such cost, and rendering all four removes a class of bug where the
 * conditional set falls out of step with what the paths reference.
 *
 * Built from the same `ARROW_MARKER_SHAPES` table the export writer serialises,
 * so an arrowhead cannot differ between screen and file.
 */
function ArrowMarkerDefs() {
  const arrows = Object.keys(ARROW_MARKER_SHAPES) as Exclude<
    ArrowType,
    "none"
  >[];
  return (
    <>
      {arrows.map((arrow) => {
        const shape = ARROW_MARKER_SHAPES[arrow];
        return (
          <marker key={arrow} id={arrowMarkerId(arrow)} {...ARROW_MARKER_BOX}>
            {shape.element === "path" ? (
              <path {...shape.attrs} />
            ) : (
              <circle {...shape.attrs} />
            )}
          </marker>
        );
      })}
    </>
  );
}

/**
 * The rubber band shown while wiring a connector.
 *
 * Resolved through the same `resolveConnector` a committed connector uses, so
 * the source end clips to the shape's perimeter identically. A bespoke line from
 * the shape's centre would preview something other than what the second click
 * actually produces.
 */
function ConnectorPreview({
  sourceId,
  sourcePortId,
  cursor,
  index,
}: {
  sourceId: string;
  sourcePortId?: string;
  cursor: Point;
  index: ReadonlyMap<string, DiagramObject>;
}) {
  const connector = previewConnector(sourceId, cursor, sourcePortId);
  const resolved = resolveConnector(connector, index);
  // Null when the source object has vanished mid-gesture; drawing to the origin
  // would be worse than drawing nothing.
  if (!resolved) return null;
  return (
    <path
      {...connectorAttrs(connector, resolved, "dom")}
      pointerEvents="none"
      vectorEffect="non-scaling-stroke"
    />
  );
}

/**
 * The snap targets shown while wiring, so a click's attachment point is visible
 * before it is committed.
 *
 * `pointerEvents` must stay off. These circles sit in the world group beside the
 * shapes, not inside them, so a port that swallowed the click would leave the
 * pointer-down handler with no `data-object-id` to resolve and the connector
 * tool would appear to do nothing at all.
 */
function PortHandles({
  object,
  zoom,
}: {
  object: DiagramObject;
  zoom: number;
}) {
  const radius = PORT_HANDLE_SCREEN_R / zoom;
  return (
    <>
      {portsOf(object).map((port) => {
        const point = portWorldPoint(object.transform, port);
        return (
          <circle
            key={port.id}
            className="canvas-port"
            cx={point.x}
            cy={point.y}
            r={radius}
            pointerEvents="none"
          />
        );
      })}
    </>
  );
}

/**
 * The in-progress shape while dragging out a new object (TRD §14.5).
 *
 * A thin wrapper: the preview is a real `DiagramObject` with a reserved id that
 * is never inserted into the document, so the geometry seen mid-drag comes from
 * exactly the code that draws the committed shape. Adding a shape to
 * `shapeGeometry` therefore adds it to the preview for free.
 *
 * Losing the `vectorEffect` the old bespoke preview used is deliberate. A
 * committed shape's stroke is in world units, so holding the preview's stroke
 * constant in screen space made the preview the one inaccurate thing on screen.
 */
function ShapePreview({
  tool,
  transform,
}: {
  tool: ShapeTool;
  transform: Transform;
}) {
  return <RenderedObject object={previewObject(tool, transform)} isPreview />;
}

export function SvgCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [isSpaceDown, setIsSpaceDown] = useState(false);

  // Granular selectors on purpose: the cursor position is published to the store
  // on every pointer move, and subscribing to the whole store would re-render the
  // canvas for it. Only the status bar reads that field.
  const objects = useDocumentStore(
    (state) =>
      state.document.pages.find((page) => page.id === state.activePageId)
        ?.objects ?? NO_OBJECTS,
  );
  const connectors = useDocumentStore(
    (state) =>
      state.document.pages.find((page) => page.id === state.activePageId)
        ?.connectors ?? NO_CONNECTORS,
  );
  // Resolved per render but memoised on the two arrays that actually change. A
  // drag re-renders this component on every pointermove, and re-resolving every
  // connector per frame would be work whose inputs have not moved.
  const resolvedConnectors = useMemo(
    () => resolveConnectors(connectors, objects),
    [connectors, objects],
  );
  const objectIndex = useMemo(() => indexObjects(objects), [objects]);
  const viewport = useEditorStore((state) => state.viewport);
  const selection = useEditorStore((state) => state.selection);
  const activeTool = useEditorStore((state) => state.activeTool);
  const grid = useEditorStore((state) => state.grid);
  const interaction = useEditorStore((state) => state.interaction);
  const hoveredId = useEditorStore((state) => state.hoveredId);
  const editingId = useEditorStore((state) => state.editingId);

  const containerRef = useRef<HTMLDivElement>(null);

  // Tracks the element size so screen-space overlays and fit-to-screen stay
  // correct. A ref plus an effect rather than a callback ref, so the observer is
  // actually disconnected on unmount instead of leaking.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        useEditorStore
          .getState()
          .setViewportSize({ x: rect.width, y: rect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") setIsSpaceDown(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setIsSpaceDown(false);
    };
    const clear = () => setIsSpaceDown(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // Delete and arrow-key nudging (FR-OBJ-06, FR-OBJ-14/15).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }

      const doc = useDocumentStore.getState();
      const hist = useHistoryStore.getState();

      // Escape abandons a half-drawn connector. Without it the only way out of
      // wiring mode is to click empty canvas, which nobody discovers by accident.
      if (event.key === "Escape") {
        const editor = useEditorStore.getState();
        if (editor.interaction?.kind === "connector") {
          editor.setInteraction(null);
          event.preventDefault();
        }
        return;
      }

      // Select all (§14.4). Deliberately ahead of the empty-selection guard,
      // since this is the shortcut you reach for when nothing is selected yet.
      // Connectors are not selected here: object and connector selection are
      // exclusive, and deleting every object already cascades to every connector
      // attached to them, so Ctrl+A then Delete still clears the whole page.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const page = doc.document.pages.find((p) => p.id === doc.activePageId);
        const selectable = (page?.objects ?? [])
          .filter((object) => object.visible && !object.locked)
          .map((object) => object.id);
        useEditorStore.getState().setSelection(selectable);
        return;
      }

      // Clipboard (FR-OBJ-16) and duplicate (FR-OBJ-05). Also ahead of the
      // empty-selection guard: paste is the one clipboard action that runs with
      // nothing selected.
      if (event.ctrlKey || event.metaKey) {
        const editor = useEditorStore.getState();
        const page = doc.document.pages.find((p) => p.id === doc.activePageId);
        const pageObjects = page?.objects ?? [];
        const key = event.key.toLowerCase();

        if (key === "c" || key === "x") {
          const ids = editor.selection;
          if (ids.length === 0) return;
          editor.setClipboard(copyObjects(pageObjects, ids));
          if (key === "x") {
            hist.execute(new DeleteObjectsCommand(doc, ids));
            editor.setSelection([]);
          }
          event.preventDefault();
          return;
        }

        if (key === "v") {
          if (editor.clipboard.length === 0) return;
          const pasted = pasteObjects(editor.clipboard, editor.nextPasteStep());
          hist.execute(new CreateObjectsCommand(doc, pasted));
          editor.setSelection(pasted.map((object) => object.id));
          event.preventDefault();
          return;
        }

        if (key === "d" && !event.shiftKey) {
          const ids = editor.selection;
          if (ids.length === 0) return;
          // Duplicate is copy plus paste in one step, and deliberately leaves the
          // clipboard alone so a later Ctrl+V still yields the original copy.
          const duplicates = pasteObjects(copyObjects(pageObjects, ids), 1);
          hist.execute(new CreateObjectsCommand(doc, duplicates));
          editor.setSelection(duplicates.map((object) => object.id));
          event.preventDefault();
          return;
        }

        // Z-order (FR-OBJ-11). Inside the modifier block because a bare bracket
        // key means nothing here, but after the clipboard keys so those keep
        // priority over an unrelated binding. Looked up by physical key code —
        // see Z_ORDER_CODES.
        const zOrder = Z_ORDER_CODES[event.code];
        if (zOrder) {
          const ids = editor.selection;
          if (ids.length === 0) return;
          const command = new ReorderObjectsCommand(
            doc,
            ids,
            event.shiftKey ? zOrder.shifted : zOrder.plain,
          );
          // A shape already at the end of the stack has nothing to do, and
          // recording the no-op would put an entry in the history that undoes
          // nothing while evicting real work from the cap.
          if (command.isNoOp) return;
          hist.execute(command);
          event.preventDefault();
          return;
        }
      }

      // Ahead of the empty-object-selection guard, because a connector selection
      // is a complete selection in its own right and would otherwise fall
      // through and do nothing at all.
      const connectorSelection = useEditorStore.getState().connectorSelection;
      if (
        connectorSelection.length > 0 &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        hist.execute(new DeleteConnectorsCommand(doc, connectorSelection));
        useEditorStore.getState().setConnectorSelection([]);
        return;
      }

      const currentSelection = useEditorStore.getState().selection;
      if (currentSelection.length === 0) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        hist.execute(new DeleteObjectsCommand(doc, currentSelection));
        useEditorStore.getState().setSelection([]);
        return;
      }

      const delta = NUDGE_DELTAS[event.key];
      if (!delta) return;

      event.preventDefault();
      const step = event.shiftKey ? NUDGE_STEP_COARSE : NUDGE_STEP;
      const from = doc.getTransforms(currentSelection);
      const to: Record<string, Transform> = {};
      for (const [id, transform] of Object.entries(from)) {
        to[id] = {
          ...transform,
          x: transform.x + delta.x * step,
          y: transform.y + delta.y * step,
        };
      }
      // execute(), not commit(): a keypress has not been applied yet, and merge()
      // collapses a held arrow key into a single undo entry.
      hist.execute(new MoveObjectsCommand(doc, currentSelection, from, to));
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toScreen = useCallback(
    (event: { clientX: number; clientY: number }): Point => {
      const rect = svgRef.current?.getBoundingClientRect();
      return {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      };
    },
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const store = useEditorStore.getState();
    const screen = toScreen(event);
    const world = screenToWorld(screen, store.viewport);
    const target = event.target as Element;
    const handle = target.getAttribute("data-handle") as ResizeHandle | null;
    const objectId = target.getAttribute("data-object-id");
    // A connector renders as a group wrapping two paths, so the hit target is
    // normally the path and the id has to be found by walking up.
    const connectorId =
      target.getAttribute("data-connector-id") ??
      target
        .closest("[data-connector-id]")
        ?.getAttribute("data-connector-id") ??
      null;

    const startPan = () => {
      event.currentTarget.setPointerCapture(event.pointerId);
      store.setInteraction({ kind: "pan", lastScreen: screen });
    };

    if (event.button === 1 || isSpaceDown || store.activeTool === "pan") {
      startPan();
      return;
    }
    if (event.button !== 0) return;

    if (isShapeTool(store.activeTool)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      store.setInteraction({
        kind: "create",
        tool: store.activeTool,
        startWorld: world,
        currentWorld: world,
      });
      return;
    }

    if (store.activeTool === "connector") {
      // Two clicks rather than a drag: the first picks the source shape, the
      // second the target. Deliberately no pointer capture — capture retargets
      // compatibility mouse events to the capturing element, which would leave
      // the second click landing on the <svg> instead of the shape under it.
      const pending =
        store.interaction?.kind === "connector" ? store.interaction : null;

      // Snap to a port when the click lands near one, so the edge is pinned to
      // the side the user chose instead of sliding along the perimeter every
      // time the far shape moves. Missing a port is not an error: a bare object
      // reference still resolves, to a perimeter clip.
      const endpointFor = (id: string): ConnectorEndpoint => {
        const found = objects.find((object) => object.id === id);
        const hit = found
          ? nearestPort(found, world, PORT_SNAP_SCREEN_PX / store.viewport.zoom)
          : null;
        return hit ? { objectId: id, portId: hit.portId } : { objectId: id };
      };

      if (!objectId) {
        // Empty canvas abandons the pending wire. Leaving the rubber band up
        // would make the user hunt for Escape to exit a mode they believe they
        // already left by clicking away.
        if (pending) store.setInteraction(null);
        return;
      }

      if (!pending) {
        store.setInteraction({
          kind: "connector",
          sourceId: objectId,
          sourcePortId: endpointFor(objectId).portId,
          currentWorld: world,
        });
        return;
      }

      // Clicking the source again is a mis-click, not a request for a self-loop.
      if (pending.sourceId === objectId) return;

      const connector = createConnector(
        { objectId: pending.sourceId, portId: pending.sourcePortId },
        endpointFor(objectId),
      );
      useHistoryStore
        .getState()
        .execute(
          new CreateConnectorsCommand(useDocumentStore.getState(), [connector]),
        );
      store.setInteraction(null);
      store.setSelection([objectId]);
      // Matches the shape tools: a finished gesture hands control back.
      store.setTool("select");
      return;
    }

    if (handle && store.selection.length === 1) {
      const single = store.selection[0];
      const found = objects.find((object) => object.id === single);
      if (found && handle) {
        event.currentTarget.setPointerCapture(event.pointerId);
        store.setInteraction({
          kind: "resize",
          id: found.id,
          handle,
          startWorld: world,
          from: found.transform,
          // A circle must stay round; see ResizeConstraints.square. Resolved
          // here rather than per pointermove so the drag does no extra lookup.
          square: found.type === "circle",
        });
        return;
      }
    }

    if (connectorId) {
      const already = store.connectorSelection.includes(connectorId);
      store.setConnectorSelection(
        event.shiftKey
          ? already
            ? store.connectorSelection.filter((id) => id !== connectorId)
            : [...store.connectorSelection, connectorId]
          : // A plain click on an already-selected connector keeps it selected so
            // the gesture can turn into something else; otherwise it replaces.
            already && store.connectorSelection.length === 1
            ? store.connectorSelection
            : [connectorId],
      );
      // No move interaction: connectors have no transform of their own to drag,
      // their geometry follows the objects they are attached to.
      return;
    }

    if (objectId) {
      const nextSelection = event.shiftKey
        ? store.selection.includes(objectId)
          ? store.selection.filter((id) => id !== objectId)
          : [...store.selection, objectId]
        : store.selection.includes(objectId)
          ? store.selection
          : [objectId];
      store.setSelection(nextSelection);
      event.currentTarget.setPointerCapture(event.pointerId);
      store.setInteraction({
        kind: "move",
        ids: nextSelection,
        startWorld: world,
        from: useDocumentStore.getState().getTransforms(nextSelection),
      });
      return;
    }

    if (!event.shiftKey) store.setSelection([]);
    event.currentTarget.setPointerCapture(event.pointerId);
    store.setInteraction({
      kind: "marquee",
      startWorld: world,
      currentWorld: world,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const store = useEditorStore.getState();
    const screen = toScreen(event);
    const world = screenToWorld(screen, store.viewport);
    store.setCursorWorld(world);

    const target = event.target as Element;
    const hovered =
      target.getAttribute("data-object-id") ??
      target.closest("[data-object-id]")?.getAttribute("data-object-id") ??
      null;
    store.setHovered(hovered);

    const current = store.interaction;
    if (!current) return;
    const doc = useDocumentStore.getState();

    switch (current.kind) {
      case "pan":
        store.pan(
          screen.x - current.lastScreen.x,
          screen.y - current.lastScreen.y,
        );
        store.setInteraction({ ...current, lastScreen: screen });
        break;

      case "marquee":
      case "create":
      // The connector rubber band tracks the cursor between the two clicks, so
      // it is the same shape of update as a marquee or a drag-out preview.
      case "connector":
        store.setInteraction({ ...current, currentWorld: world });
        break;

      case "move": {
        const anchor = store.grid.enabled
          ? snapPoint(world, store.grid.size)
          : world;
        const dx = anchor.x - current.startWorld.x;
        const dy = anchor.y - current.startWorld.y;
        const next: Record<string, Transform> = {};
        for (const [id, transform] of Object.entries(current.from)) {
          next[id] = { ...transform, x: transform.x + dx, y: transform.y + dy };
        }
        doc.setTransforms(next);
        break;
      }

      case "resize": {
        const dx = world.x - current.startWorld.x;
        const dy = world.y - current.startWorld.y;
        doc.setTransforms({
          [current.id]: resizeTransform(current.from, current.handle, dx, dy, {
            square: current.square,
          }),
        });
        break;
      }
    }
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const store = useEditorStore.getState();
    const current = store.interaction;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!current) return;

    const doc = useDocumentStore.getState();
    const hist = useHistoryStore.getState();
    // Every other gesture is one press-drag-release, so pointer-up ends it. A
    // connector spans two separate clicks, and clearing here would discard the
    // pending source the moment the first click was released — the second click
    // would then start a fresh wire instead of completing one, so no connector
    // could ever be created. Its lifecycle is owned by pointer-down and Escape.
    if (current.kind !== "connector") store.setInteraction(null);

    switch (current.kind) {
      case "pan":
        // Viewport is part of the saved document (§12.1), so persist it once the
        // gesture ends rather than on every frame.
        doc.setViewport(store.viewport);
        break;

      case "create": {
        const transform = normaliseDragTransform(
          current.startWorld,
          current.currentWorld,
          current.tool,
        );
        const object = createObject(current.tool, transform);
        hist.execute(new CreateObjectsCommand(doc, [object]));
        store.setSelection([object.id]);
        // Back to select, so the next click does not draw another shape.
        store.setTool("select");
        break;
      }

      case "move": {
        const to = doc.getTransforms(current.ids);
        const moved = current.ids.some((id) => {
          const before = current.from[id];
          const after = to[id];
          return Boolean(
            before && after && (before.x !== after.x || before.y !== after.y),
          );
        });
        // A click without movement must not create an undo entry.
        if (moved)
          hist.commit(
            new MoveObjectsCommand(doc, current.ids, current.from, to),
          );
        break;
      }

      case "resize": {
        const to = doc.getTransforms([current.id]);
        const after = to[current.id];
        const before = current.from;
        const changed =
          after &&
          (after.x !== before.x ||
            after.y !== before.y ||
            after.width !== before.width ||
            after.height !== before.height);
        if (changed) {
          hist.commit(
            new ResizeObjectCommand(
              doc,
              [current.id],
              { [current.id]: before },
              to,
            ),
          );
        }
        break;
      }

      case "marquee": {
        const box = {
          x: Math.min(current.startWorld.x, current.currentWorld.x),
          y: Math.min(current.startWorld.y, current.currentWorld.y),
          width: Math.abs(current.currentWorld.x - current.startWorld.x),
          height: Math.abs(current.currentWorld.y - current.startWorld.y),
        };
        if (box.width < 2 && box.height < 2) break;
        const hit = objects
          .filter((object) => object.visible && !object.locked)
          .filter((object) => intersects(objectBounds(object), box))
          .map((object) => object.id);
        store.setSelection(
          event.shiftKey
            ? Array.from(new Set([...store.selection, ...hit]))
            : hit,
        );
        break;
      }
    }
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    const store = useEditorStore.getState();
    const screen = toScreen(event);
    if (event.ctrlKey || event.metaKey) {
      // A trackpad pinch arrives as ctrl+wheel; exponential keeps it feel-linear.
      store.zoomBy(Math.exp(-event.deltaY * 0.01), screen);
    } else {
      store.pan(-event.deltaX, -event.deltaY);
    }
  };

  const gridPitch = grid.size * viewport.zoom;
  const worldTransform = `translate(${-viewport.x * viewport.zoom} ${-viewport.y * viewport.zoom}) scale(${viewport.zoom})`;
  const handleSize = HANDLE_SCREEN_SIZE / viewport.zoom;
  const selectedObjects = objects.filter((object) =>
    selection.includes(object.id),
  );
  const singleSelection =
    selectedObjects.length === 1 ? selectedObjects[0] : undefined;
  const hoveredObject = hoveredId
    ? objects.find((object) => object.id === hoveredId)
    : undefined;

  /**
   * Shapes worth showing snap targets for while wiring: the one under the
   * cursor, plus the one already chosen as the source so the user can see where
   * it is pinned. Empty for every other tool, and a stable reference so this
   * does not invalidate anything downstream on each render.
   */
  const portTargets =
    activeTool === "connector"
      ? objects.filter(
          (object) =>
            object.id === hoveredId ||
            (interaction?.kind === "connector" &&
              object.id === interaction.sourceId),
        )
      : NO_OBJECTS;

  const marquee =
    interaction?.kind === "marquee"
      ? (() => {
          const start = worldToScreen(interaction.startWorld, viewport);
          const end = worldToScreen(interaction.currentWorld, viewport);
          return {
            x: Math.min(start.x, end.x),
            y: Math.min(start.y, end.y),
            width: Math.abs(end.x - start.x),
            height: Math.abs(end.y - start.y),
          };
        })()
      : null;

  const cursor =
    isSpaceDown || activeTool === "pan"
      ? "grab"
      : isShapeTool(activeTool) || activeTool === "connector"
        ? "crosshair"
        : "default";

  const editingObject = editingId
    ? objects.find(
        (object) => object.id === editingId && object.type === "text",
      )
    : undefined;

  const editingConnector = editingId
    ? connectors.find((connector) => connector.id === editingId)
    : undefined;
  // Without a resolved path there is no anchor to place the field at, which
  // happens when the connector's endpoint object was deleted mid-edit.
  const editingConnectorAnchor = editingConnector
    ? resolvedConnectors.get(editingConnector.id)?.labelAnchor
    : undefined;

  const editingTarget: TextEditorTarget | undefined = editingObject
    ? (() => {
        const worldFontSize = editingObject.style.text?.fontSize ?? 14;
        return {
          initialValue: editingObject.content?.value ?? "",
          origin: {
            x: editingObject.transform.x,
            y: editingObject.transform.y,
          },
          worldWidth: editingObject.transform.width,
          worldFontSize,
          // Zoom cancels out of the ratio, so rows do not change with it.
          rows: Math.max(
            1,
            Math.round(editingObject.transform.height / (worldFontSize * 1.4)),
          ),
          ariaLabel: `Edit the label for ${editingObject.name ?? "this object"}`,
        };
      })()
    : editingConnector && editingConnectorAnchor
      ? {
          initialValue: editingConnector.label?.value ?? "",
          // Centred on the anchor, matching how the label itself is drawn: the
          // text is middle-anchored, so a top-left-aligned field would sit off to
          // one side of the line it edits.
          origin: {
            x: editingConnectorAnchor.x - CONNECTOR_LABEL_FIELD_WIDTH / 2,
            y: editingConnectorAnchor.y - CONNECTOR_LABEL_FONT_SIZE,
          },
          worldWidth: CONNECTOR_LABEL_FIELD_WIDTH,
          worldFontSize:
            editingConnector.label?.style?.fontSize ??
            CONNECTOR_LABEL_FONT_SIZE,
          rows: 1,
          ariaLabel: "Edit the label for this connector",
        }
      : undefined;

  /**
   * Double-click starts an inline label edit (FR-TEXT-02), for a text object or
   * for a connector.
   */
  const onDoubleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    // `event.target` cannot be trusted here. The pointerdown that preceded this
    // double-click called setPointerCapture on the <svg>, and while capture is
    // active the browser retargets compatibility mouse events (click, dblclick)
    // to the capturing element — so target is always the <svg>, never the shape.
    // Hit-testing the coordinates goes through the layout instead and is
    // unaffected by capture. (onPointerDown does not have this problem: it reads
    // target before requesting capture.)
    const editor = useEditorStore.getState();

    // Walked in paint order, topmost first, and resolved per element rather than
    // by filtering the whole list for one attribute. Connectors paint above
    // shapes, so a double-click on a line crossing a shape has to resolve to the
    // connector; collecting every object id first would find the shape
    // underneath and open the wrong editor.
    for (const element of document.elementsFromPoint(
      event.clientX,
      event.clientY,
    )) {
      const connectorId = element
        .closest("[data-connector-id]")
        ?.getAttribute("data-connector-id");
      if (connectorId) {
        const connector = connectors.find(
          (candidate) => candidate.id === connectorId,
        );
        if (!connector || connector.locked || !connector.visible) return;
        editor.setConnectorSelection([connectorId]);
        editor.setEditing(connectorId);
        return;
      }

      const objectId = element
        .closest("[data-object-id]")
        ?.getAttribute("data-object-id");
      if (objectId) {
        const object = objects.find((candidate) => candidate.id === objectId);
        // Restricted to text objects: a shape can carry a label in the document
        // model, but nothing renders one yet, so editing a shape's label would
        // change data the user cannot see.
        if (
          !object ||
          object.locked ||
          !object.visible ||
          object.type !== "text"
        )
          return;
        editor.setSelection([objectId]);
        editor.setEditing(objectId);
        return;
      }
    }
  };

  const handleTextCommit = useCallback((value: string) => {
    const editor = useEditorStore.getState();
    const id = editor.editingId;
    editor.setEditing(null);
    if (!id) return;

    const doc = useDocumentStore.getState();
    const hist = useHistoryStore.getState();
    const page = doc.document.pages.find((p) => p.id === doc.activePageId);

    // Object ids and connector ids are disjoint, so which collection the edit
    // lands in is settled by lookup rather than by carrying a kind flag on the
    // store alongside the id.
    if ((page?.connectors ?? []).some((entry) => entry.id === id)) {
      const from = doc.getConnectorLabels([id]);
      if ((from[id]?.value ?? "") === value) return;
      hist.execute(
        new UpdateConnectorLabelCommand(doc, [id], from, {
          // Empty clears the label rather than storing a blank one, so the saved
          // document does not accumulate empty TextContent shells.
          [id]: value.length > 0 ? { value } : undefined,
        }),
      );
      return;
    }

    const from = doc.getContents([id]);
    // An unchanged label must not create an undo entry.
    if ((from[id]?.value ?? "") === value) return;

    hist.execute(
      new UpdateContentCommand(doc, [id], from, { [id]: { value } }),
    );
  }, []);

  const handleTextCancel = useCallback(() => {
    useEditorStore.getState().setEditing(null);
  }, []);

  return (
    <div ref={containerRef} className="canvas-host">
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{ display: "block", cursor, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
      >
        <defs>
          <pattern
            id="astryx-grid"
            width={gridPitch}
            height={gridPitch}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${(-viewport.x * viewport.zoom) % gridPitch} ${
              (-viewport.y * viewport.zoom) % gridPitch
            })`}
          >
            {grid.type === "dot" ? (
              <circle cx={1} cy={1} r={1} className="canvas-grid-mark" />
            ) : (
              <path
                d={`M ${gridPitch} 0 L 0 0 0 ${gridPitch}`}
                className="canvas-grid-line"
                fill="none"
              />
            )}
          </pattern>
          {/* The same arrowheads the export writer serialises, from one shared
              table, so a head cannot look different on screen and in the file
              (FR-EXP-11 rule 7). */}
          <ArrowMarkerDefs />
        </defs>

        {grid.enabled && gridPitch > MIN_GRID_PITCH ? (
          <rect
            width="100%"
            height="100%"
            fill="url(#astryx-grid)"
            pointerEvents="none"
          />
        ) : null}

        <g transform={worldTransform}>
          {objects
            .filter((object) => object.visible)
            .map((object) => (
              <RenderedObject key={object.id} object={object} />
            ))}

          {/* After the objects, matching the export writer: an arrowhead meeting
              a shape's perimeter would otherwise be half-covered by the shape it
              points at. A connector that cannot resolve — an endpoint object
              that is gone with no fallback point — is skipped rather than drawn
              to the origin, which would invent an edge nobody authored. */}
          {connectors
            .filter((connector) => connector.visible)
            .map((connector) => {
              const resolved = resolvedConnectors.get(connector.id);
              return resolved ? (
                <RenderedConnector
                  key={connector.id}
                  connector={connector}
                  resolved={resolved}
                />
              ) : null;
            })}

          {interaction?.kind === "create" ? (
            <ShapePreview
              tool={interaction.tool}
              transform={normaliseDragTransform(
                interaction.startWorld,
                interaction.currentWorld,
                interaction.tool,
              )}
            />
          ) : null}

          {interaction?.kind === "connector" ? (
            <ConnectorPreview
              sourceId={interaction.sourceId}
              sourcePortId={interaction.sourcePortId}
              cursor={interaction.currentWorld}
              index={objectIndex}
            />
          ) : null}

          {/* Drawn last so the snap targets sit above the shapes and the rubber
              band rather than being hidden by either. */}
          {portTargets.map((object) => (
            <PortHandles key={object.id} object={object} zoom={viewport.zoom} />
          ))}

          {hoveredObject && !selection.includes(hoveredObject.id) ? (
            <rect
              className="canvas-hover-outline"
              x={objectBounds(hoveredObject).x}
              y={objectBounds(hoveredObject).y}
              width={objectBounds(hoveredObject).width}
              height={objectBounds(hoveredObject).height}
              fill="none"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ) : null}

          {selectedObjects.map((object) => {
            const box = objectBounds(object);
            return (
              <rect
                key={`selection-${object.id}`}
                className="canvas-selection-outline"
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                fill="none"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            );
          })}

          {/* Suppressed while wiring. The edge handles sit at the box's edge
              midpoints — the same coordinates as the n/e/s/w ports — and carry
              pointerEvents, so they swallowed the click and made those four
              ports unreachable on any selected shape. Since a shape is selected
              the moment it is drawn, that broke connecting two shapes at their
              facing ports, which is the gesture almost every diagram starts
              with. They are also the wrong affordance in this mode: you are not
              resizing. */}
          {singleSelection &&
          !singleSelection.locked &&
          activeTool !== "connector"
            ? HANDLES.map((handle) => {
                const box = objectBounds(singleSelection);
                const offset = handleOffset(handle);
                return (
                  <rect
                    key={`handle-${handle}`}
                    data-handle={handle}
                    className="canvas-resize-handle"
                    x={box.x + box.width * offset.x - handleSize / 2}
                    y={box.y + box.height * offset.y - handleSize / 2}
                    width={handleSize}
                    height={handleSize}
                    style={{ cursor: `${handle}-resize`, pointerEvents: "all" }}
                  />
                );
              })
            : null}
        </g>

        {marquee ? (
          <rect
            className="canvas-marquee"
            x={marquee.x}
            y={marquee.y}
            width={marquee.width}
            height={marquee.height}
            pointerEvents="none"
          />
        ) : null}
      </svg>

      {editingTarget ? (
        <TextEditorOverlay
          target={editingTarget}
          viewport={viewport}
          onCommit={handleTextCommit}
          onCancel={handleTextCancel}
        />
      ) : null}
    </div>
  );
}
