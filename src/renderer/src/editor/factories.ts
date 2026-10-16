import type {
  DiagramObject,
  DiagramStyle,
  ObjectType,
  TextContent,
  Transform,
} from "../document/model";
import type { ColorValue } from "../document/model";

/**
 * Default object appearance.
 *
 * Colours carry a token reference *and* a resolved hex fallback, which is what
 * TRD §12.3 rule 3 asks for and what makes both renderers work: the live DOM can
 * paint `var(--color-...)` and follow theme and dark-mode changes for free,
 * while a standalone SVG export (FR-EXP-12) has a concrete colour to fall back
 * to once it is detached from the app's stylesheet.
 *
 * The hex values are the light-mode stops of the neutral theme's `light-dark()`
 * pairs, read from `@astryxdesign/theme-neutral/dist/theme.css`.
 */
export const DEFAULT_FILL: ColorValue = {
  token: "--color-background-surface",
  hex: "#ffffff",
};

export const DEFAULT_STROKE: ColorValue = {
  token: "--color-accent",
  hex: "#1b1b1b",
};

export const DEFAULT_TEXT_COLOR: ColorValue = {
  token: "--color-text-primary",
  hex: "#000000",
};

export function defaultStyle(): DiagramStyle {
  return {
    fill: DEFAULT_FILL,
    stroke: DEFAULT_STROKE,
    strokeWidth: 2,
    opacity: 1,
    cornerRadius: 0,
    text: { fontSize: 14, textAlign: "center" },
  };
}

export function identityTransform(x: number, y: number, width: number, height: number): Transform {
  return { x, y, width, height, rotation: 0, scaleX: 1, scaleY: 1 };
}

/** Tools that can be dragged out on the canvas (TRD §14.5). */
export type ShapeTool = "rectangle" | "roundedRectangle" | "ellipse" | "text";

const TOOL_TO_OBJECT_TYPE: Record<ShapeTool, ObjectType> = {
  rectangle: "rectangle",
  roundedRectangle: "roundedRectangle",
  ellipse: "ellipse",
  text: "text",
};

const DEFAULT_SIZES: Record<ShapeTool, { width: number; height: number }> = {
  rectangle: { width: 160, height: 100 },
  roundedRectangle: { width: 160, height: 100 },
  ellipse: { width: 140, height: 140 },
  text: { width: 200, height: 40 },
};

let counter = 0;

/**
 * Locally unique ids. `crypto.randomUUID` would also work, but a readable,
 * monotonic id makes saved documents and test failures far easier to follow, and
 * the format still satisfies the conservative id pattern the autosave store
 * enforces on document ids.
 */
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}_${Date.now().toString(36)}`;
}

export function createObject(
  tool: ShapeTool,
  transform: Transform,
  overrides: { style?: Partial<DiagramStyle>; content?: TextContent; name?: string } = {},
): DiagramObject {
  const style = { ...defaultStyle(), ...overrides.style };

  if (tool === "roundedRectangle" && style.cornerRadius === 0) {
    style.cornerRadius = 12;
  }

  return {
    id: nextId("obj"),
    type: TOOL_TO_OBJECT_TYPE[tool],
    name: overrides.name,
    zIndex: 0,
    visible: true,
    locked: false,
    transform,
    style,
    content: overrides.content ?? (tool === "text" ? { value: "Text" } : undefined),
  };
}

export function defaultSizeFor(tool: ShapeTool): { width: number; height: number } {
  return DEFAULT_SIZES[tool];
}

/**
 * Normalises a drag-produced transform so a shape drawn right-to-left or
 * bottom-to-top still has positive dimensions, and collapses a click-without-drag
 * to the tool's default size rather than a zero-area object that cannot be
 * selected again.
 */
export function normaliseDragTransform(
  start: { x: number; y: number },
  end: { x: number; y: number },
  tool: ShapeTool,
): Transform {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  const fallback = DEFAULT_SIZES[tool];
  return identityTransform(
    x,
    y,
    width < 4 ? fallback.width : width,
    height < 4 ? fallback.height : height,
  );
}
