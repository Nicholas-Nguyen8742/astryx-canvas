import { create } from "zustand";

import type {
  GridSettings,
  Point,
  Transform,
  Viewport,
} from "../document/model";
import { clampZoom, panByScreen, zoomAt } from "../editor/geometry";
import type { ShapeTool } from "../editor/factories";

/** TRD §14.5. */
export type ActiveTool =
  | "select"
  | "rectangle"
  | "roundedRectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "connector"
  | "text"
  | "stickyNote"
  | "image"
  | "pan"
  | "zoom";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * A gesture in progress.
 *
 * This lives in the editor store, never in history: while dragging, the canvas
 * is updated directly so pointer latency stays under a frame (NFR-PERF-04), and
 * only the completed gesture is committed as a single undo entry
 * (TRD §13.2 rule 2).
 */
export type Interaction =
  | { kind: "pan"; lastScreen: Point }
  | { kind: "marquee"; startWorld: Point; currentWorld: Point }
  | {
      kind: "move";
      ids: string[];
      startWorld: Point;
      /** Pre-gesture transforms, so the finished drag becomes one undo entry. */
      from: Record<string, Transform>;
    }
  | {
      kind: "resize";
      id: string;
      handle: ResizeHandle;
      startWorld: Point;
      from: Transform;
    }
  | { kind: "create"; tool: ShapeTool; startWorld: Point; currentWorld: Point };

export const SHAPE_TOOLS = [
  "rectangle",
  "roundedRectangle",
  "ellipse",
  "text",
] as const;

export function isShapeTool(tool: ActiveTool): tool is ShapeTool {
  return (SHAPE_TOOLS as readonly string[]).includes(tool);
}

export const DEFAULT_GRID: GridSettings = {
  enabled: true,
  size: 10,
  type: "dot",
};

export interface EditorState {
  activeTool: ActiveTool;
  /** Selection is stored as ids, never object references (TRD §13.2 rule 4). */
  selection: string[];
  hoveredId: string | null;
  viewport: Viewport;
  /** Size of the canvas element in CSS pixels, as {x: width, y: height}. */
  viewportSize: Point;
  grid: GridSettings;
  cursorWorld: Point | null;
  interaction: Interaction | null;

  setTool(tool: ActiveTool): void;
  setSelection(ids: readonly string[]): void;
  toggleInSelection(id: string): void;
  clearSelection(): void;
  setHovered(id: string | null): void;
  setViewportSize(size: Point): void;
  setViewport(viewport: Viewport): void;
  pan(deltaScreenX: number, deltaScreenY: number): void;
  zoomBy(factor: number, anchorScreen: Point): void;
  resetZoom(): void;
  toggleGrid(): void;
  setCursorWorld(point: Point | null): void;
  setInteraction(interaction: Interaction | null): void;
}

export function createEditorStore() {
  return create<EditorState>()((set, get) => ({
    activeTool: "select",
    selection: [],
    hoveredId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportSize: { x: 0, y: 0 },
    grid: DEFAULT_GRID,
    cursorWorld: null,
    interaction: null,

    setTool(tool) {
      // Leaving a drawing tool clears any half-finished gesture so a stale
      // interaction cannot be resumed by the next pointer down.
      set({ activeTool: tool, interaction: null });
    },

    setSelection(ids) {
      const unique = Array.from(new Set(ids));
      set({ selection: unique });
    },

    toggleInSelection(id) {
      const { selection } = get();
      set({
        selection: selection.includes(id)
          ? selection.filter((existing) => existing !== id)
          : [...selection, id],
      });
    },

    clearSelection() {
      set({ selection: [], interaction: null });
    },

    setHovered(id) {
      set({ hoveredId: id });
    },

    setViewportSize(size) {
      set({ viewportSize: size });
    },

    setViewport(viewport) {
      set({ viewport: { ...viewport, zoom: clampZoom(viewport.zoom) } });
    },

    pan(deltaScreenX, deltaScreenY) {
      set({
        viewport: panByScreen(get().viewport, deltaScreenX, deltaScreenY),
      });
    },

    zoomBy(factor, anchorScreen) {
      set({ viewport: zoomAt(get().viewport, anchorScreen, factor) });
    },

    resetZoom() {
      const { viewport } = get();
      set({ viewport: { ...viewport, zoom: 1 } });
    },

    toggleGrid() {
      const { grid } = get();
      set({ grid: { ...grid, enabled: !grid.enabled } });
    },

    setCursorWorld(point) {
      set({ cursorWorld: point });
    },

    setInteraction(interaction) {
      set({ interaction });
    },
  }));
}

export const useEditorStore = createEditorStore();
