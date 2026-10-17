import type {
  ColorValue,
  DiagramObject,
  Transform,
} from "../../document/model";

/**
 * Resolves a document colour for a given target.
 *
 * In the live DOM we emit `var(--token)` so objects follow theme and dark-mode
 * changes with no repaint logic of our own. For a standalone export that has to
 * fall back to the concrete hex, because the exported file leaves the app's
 * stylesheet behind (FR-EXP-12). This is exactly the token-plus-fallback pairing
 * TRD §12.3 rule 3 asks the format to carry.
 */
export function resolveColor(
  color: ColorValue | undefined,
  target: "dom" | "export",
): string | undefined {
  if (!color) return undefined;
  if (target === "dom" && color.token) return `var(${color.token})`;
  return color.hex;
}

export type ShapeElement = "rect" | "ellipse" | "line" | "text" | "g";

/**
 * Single shared arrowhead marker.
 *
 * `context-stroke` makes the head follow the line's own stroke, so one marker
 * definition serves every colour. Chromium and Firefox resolve it; a renderer
 * that does not will fall back to a solid black head rather than dropping the
 * arrowhead entirely, which is the failure mode FR-EXP-11 rule 7 cares least
 * about. Both the live canvas and the export writer emit this same markup, so an
 * exported arrow keeps its head.
 */
export const ARROW_MARKER_ID = "astryx-arrowhead";

export const ARROW_MARKER_SVG =
  `<marker id="${ARROW_MARKER_ID}" viewBox="0 0 10 10" refX="9" refY="5" ` +
  `markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
  `<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker>`;

export interface ShapeGeometry {
  element: ShapeElement;
  /** Presentation and geometry attributes, in a stable key order. */
  attrs: Record<string, string | number>;
  /** Only set for text objects; each entry becomes a `<tspan>` line. */
  lines?: string[];
}

export interface LineEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Endpoints of a line or arrow, honouring the flip flags that record which
 * corner the drag started from (see `normaliseDragTransform`).
 *
 * Shared by the live renderer, the drag preview and the export writer: three
 * call sites deriving endpoints independently is how a line ends up pointing one
 * way on screen and the opposite way in the exported file.
 */
export function lineEndpoints(transform: Transform): LineEndpoints {
  return {
    x1: transform.flipX ? transform.x + transform.width : transform.x,
    y1: transform.flipY ? transform.y + transform.height : transform.y,
    x2: transform.flipX ? transform.x : transform.x + transform.width,
    y2: transform.flipY ? transform.y : transform.y + transform.height,
  };
}

function rotateAttr(object: DiagramObject): string | undefined {
  const { rotation, x, y, width, height } = object.transform;
  if (rotation === 0) return undefined;
  return `rotate(${rotation} ${x + width / 2} ${y + height / 2})`;
}

/**
 * Maps a document object to the SVG element and attributes that draw it.
 *
 * Both the live React canvas and the export serializer go through here, so a
 * shape cannot render one way on screen and another way in the exported file —
 * which is the fidelity requirement behind FR-EXP-11.
 */
export function shapeGeometry(
  object: DiagramObject,
  target: "dom" | "export",
): ShapeGeometry {
  const { transform, style } = object;
  const fill = resolveColor(style.fill, target);
  const stroke = resolveColor(style.stroke, target);

  const shared: Record<string, string | number> = {};
  if (fill !== undefined) shared.fill = fill;
  else shared.fill = "none";
  if (stroke !== undefined) shared.stroke = stroke;
  shared["stroke-width"] = style.strokeWidth ?? 1;
  if (style.opacity !== undefined && style.opacity !== 1)
    shared.opacity = style.opacity;
  if (style.dashArray && style.dashArray.length > 0)
    shared["stroke-dasharray"] = style.dashArray.join(" ");

  const rotate = rotateAttr(object);
  if (rotate) shared.transform = rotate;

  switch (object.type) {
    case "ellipse":
    case "circle":
      return {
        element: "ellipse",
        attrs: {
          ...shared,
          cx: transform.x + transform.width / 2,
          cy: transform.y + transform.height / 2,
          rx: Math.max(transform.width / 2, 0),
          ry: Math.max(transform.height / 2, 0),
        },
      };

    case "line":
    case "arrow":
      return {
        element: "line",
        attrs: {
          ...shared,
          fill: "none",
          ...lineEndpoints(transform),
          ...(object.type === "arrow"
            ? { "marker-end": `url(#${ARROW_MARKER_ID})` }
            : {}),
        },
      };

    case "text": {
      const textStyle = style.text;
      const anchor =
        textStyle?.textAlign === "left"
          ? "start"
          : textStyle?.textAlign === "right"
            ? "end"
            : "middle";
      return {
        element: "text",
        attrs: {
          ...shared,
          fill:
            resolveColor(style.text?.color as ColorValue | undefined, target) ??
            fill ??
            "currentColor",
          stroke: "none",
          x: transform.x + transform.width / 2,
          y: transform.y + transform.height / 2,
          "font-size": textStyle?.fontSize ?? 14,
          "text-anchor": anchor,
          "dominant-baseline": "middle",
        },
        lines: (object.content?.value ?? "").split("\n"),
      };
    }

    case "rectangle":
    case "roundedRectangle":
    case "group":
    case "stencil":
    default: {
      const radius =
        object.type === "roundedRectangle"
          ? (style.cornerRadius ?? 8)
          : (style.cornerRadius ?? 0);
      return {
        element: "rect",
        attrs: {
          ...shared,
          x: transform.x,
          y: transform.y,
          width: Math.max(transform.width, 0),
          height: Math.max(transform.height, 0),
          ...(radius > 0 ? { rx: radius, ry: radius } : {}),
        },
      };
    }
  }
}

/** Escape the five characters that are illegal in XML text and attributes. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
