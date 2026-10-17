import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { DiagramObject, Point, Transform } from "../../document/model";
import {
  intersects,
  objectBounds,
  screenToWorld,
  snapPoint,
  worldToScreen,
} from "../geometry";
import {
  createObject,
  normaliseDragTransform,
  type ShapeTool,
} from "../factories";
import {
  CreateObjectsCommand,
  DeleteObjectsCommand,
  MoveObjectsCommand,
  ResizeObjectCommand,
  UpdateContentCommand,
} from "../commands/object-commands";
import { copyObjects, pasteObjects } from "../clipboard";
import { useDocumentStore } from "../../state/document-store";
import { useHistoryStore } from "../../state/history-store";
import {
  isShapeTool,
  useEditorStore,
  type ResizeHandle,
} from "../../state/editor-store";
import { ARROW_MARKER_ID, lineEndpoints, shapeGeometry } from "./shape-attrs";
import { TextEditorOverlay } from "./TextEditorOverlay";

/** Handle edge length in screen pixels, so handles stay grabbable at any zoom. */
const HANDLE_SCREEN_SIZE = 8;
/** A line has no fill to click, so it gets an invisible constant-width hit stroke. */
const LINE_HIT_WIDTH = 12;
const MIN_OBJECT_SIZE = 4;
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

const NUDGE_DELTAS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

function handleOffset(handle: ResizeHandle): Point {
  return {
    x: handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5,
    y: handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5,
  };
}

/**
 * Resizes from a dragged handle while keeping the opposite edge anchored, and
 * refuses to invert: dragging past the anchor clamps rather than flipping, which
 * is what makes a resize feel predictable.
 */
export function resizeTransform(
  from: Transform,
  handle: ResizeHandle,
  dx: number,
  dy: number,
): Transform {
  let left = from.x;
  let top = from.y;
  let right = from.x + from.width;
  let bottom = from.y + from.height;

  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;

  if (right - left < MIN_OBJECT_SIZE) {
    if (handle.includes("w")) left = right - MIN_OBJECT_SIZE;
    else right = left + MIN_OBJECT_SIZE;
  }
  if (bottom - top < MIN_OBJECT_SIZE) {
    if (handle.includes("n")) top = bottom - MIN_OBJECT_SIZE;
    else bottom = top + MIN_OBJECT_SIZE;
  }

  return {
    ...from,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function RenderedObject({ object }: { object: DiagramObject }) {
  const geometry = shapeGeometry(object, "dom");
  const common = {
    "data-object-id": object.id,
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

  return <rect {...geometry.attrs} {...common} />;
}

/**
 * The in-progress shape while dragging out a new object.
 *
 * Deliberately not a `DiagramObject`: building one per pointer-move would mint a
 * fresh id on every frame and churn the factory counter for something that is
 * discarded unless the gesture completes.
 */
function ShapePreview({
  tool,
  transform,
}: {
  tool: ShapeTool;
  transform: Transform;
}) {
  const shared = {
    className: "canvas-preview",
    fill: "none",
    strokeWidth: 2,
    vectorEffect: "non-scaling-stroke" as const,
    strokeDasharray: "6 4",
    pointerEvents: "none" as const,
  };

  if (tool === "ellipse") {
    return (
      <ellipse
        {...shared}
        cx={transform.x + transform.width / 2}
        cy={transform.y + transform.height / 2}
        rx={Math.max(transform.width / 2, 0)}
        ry={Math.max(transform.height / 2, 0)}
      />
    );
  }

  if (tool === "line" || tool === "arrow") {
    return (
      <line
        {...shared}
        {...lineEndpoints(transform)}
        markerEnd={tool === "arrow" ? `url(#${ARROW_MARKER_ID})` : undefined}
      />
    );
  }

  return (
    <rect
      {...shared}
      x={transform.x}
      y={transform.y}
      width={Math.max(transform.width, 0)}
      height={Math.max(transform.height, 0)}
      rx={tool === "roundedRectangle" ? 12 : 0}
    />
  );
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

      // Select all (§14.4). Deliberately ahead of the empty-selection guard,
      // since this is the shortcut you reach for when nothing is selected yet.
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
        }
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
        });
        return;
      }
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
          [current.id]: resizeTransform(current.from, current.handle, dx, dy),
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
    store.setInteraction(null);

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
      : isShapeTool(activeTool)
        ? "crosshair"
        : "default";

  const editingObject = editingId
    ? objects.find(
        (object) => object.id === editingId && object.type === "text",
      )
    : undefined;

  /**
   * Double-click starts an inline label edit (FR-TEXT-02). Restricted to text
   * objects: a shape can carry a label in the document model, but nothing renders
   * one yet, so editing a shape's label would change data the user cannot see.
   */
  const onDoubleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    // `event.target` cannot be trusted here. The pointerdown that preceded this
    // double-click called setPointerCapture on the <svg>, and while capture is
    // active the browser retargets compatibility mouse events (click, dblclick)
    // to the capturing element — so target is always the <svg>, never the shape.
    // Hit-testing the coordinates goes through the layout instead and is
    // unaffected by capture. (onPointerDown does not have this problem: it reads
    // target before requesting capture.)
    const objectId =
      document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest("[data-object-id]"))
        .find((element): element is Element => element !== null)
        ?.getAttribute("data-object-id") ?? null;

    if (!objectId) return;

    const object = objects.find((candidate) => candidate.id === objectId);
    if (!object || object.locked || !object.visible || object.type !== "text")
      return;

    const editor = useEditorStore.getState();
    editor.setSelection([objectId]);
    editor.setEditing(objectId);
  };

  const handleTextCommit = useCallback((value: string) => {
    const editor = useEditorStore.getState();
    const id = editor.editingId;
    editor.setEditing(null);
    if (!id) return;

    const doc = useDocumentStore.getState();
    const from = doc.getContents([id]);
    // An unchanged label must not create an undo entry.
    if ((from[id]?.value ?? "") === value) return;

    useHistoryStore
      .getState()
      .execute(new UpdateContentCommand(doc, [id], from, { [id]: { value } }));
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
          {/* Same arrowhead the export writer emits, so an arrow looks identical
              on screen and in the exported file (FR-EXP-11 rule 7). */}
          <marker
            id={ARROW_MARKER_ID}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={7}
            markerHeight={7}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
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

          {singleSelection && !singleSelection.locked
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

      {editingObject ? (
        <TextEditorOverlay
          object={editingObject}
          viewport={viewport}
          onCommit={handleTextCommit}
          onCancel={handleTextCancel}
        />
      ) : null}
    </div>
  );
}
