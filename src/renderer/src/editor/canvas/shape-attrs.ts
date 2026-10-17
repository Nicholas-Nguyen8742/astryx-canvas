import type {
  ArrowType,
  ColorValue,
  Connector,
  DiagramObject,
  TextContent,
  Transform,
} from "../../document/model";
import type { ResolvedConnector } from "../connectors";

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

export type ShapeElement =
  "rect" | "ellipse" | "line" | "text" | "polygon" | "g";

/**
 * Arrowhead markers.
 *
 * `context-stroke` makes a head follow its own path's stroke, so one definition
 * per *shape* serves every colour and every theme — four shapes, not four shapes
 * times every stroke. Chromium and Firefox resolve it; a renderer that does not
 * falls back to a solid black head rather than dropping the arrowhead entirely,
 * which is the failure mode FR-EXP-11 rule 7 cares least about.
 *
 * Both the live canvas and the export writer emit this same markup, so an
 * exported arrow keeps its head.
 */
export const ARROW_MARKER_ID = "astryx-arrowhead";

/**
 * Arrowhead geometry, described as data rather than markup.
 *
 * Drawn inside a `0 0 10 10` viewBox with the tip at x=10. Both renderers
 * consume this one table: the export writer serialises it to a string and the
 * live canvas turns it into elements. Describing the heads twice, once as a
 * template string and once as JSX, is how an exported arrowhead ends up subtly
 * different from the one on screen.
 */
export interface ArrowMarkerShape {
  element: "path" | "circle";
  attrs: Record<string, string | number>;
}

export const ARROW_MARKER_SHAPES: Record<
  Exclude<ArrowType, "none">,
  ArrowMarkerShape
> = {
  triangle: {
    element: "path",
    attrs: { d: "M 0 0 L 10 5 L 0 10 z", fill: "context-stroke" },
  },
  open: {
    element: "path",
    attrs: {
      d: "M 0 0 L 10 5 L 0 10",
      fill: "none",
      stroke: "context-stroke",
      "stroke-width": 1.5,
    },
  },
  diamond: {
    element: "path",
    attrs: { d: "M 0 5 L 5 0 L 10 5 L 5 10 z", fill: "context-stroke" },
  },
  circle: {
    element: "circle",
    attrs: { cx: 5, cy: 5, r: 4, fill: "context-stroke" },
  },
};

/** Box and reference point shared by every head, so they cannot drift apart. */
export const ARROW_MARKER_BOX = {
  viewBox: "0 0 10 10",
  refX: 9,
  refY: 5,
  markerWidth: 7,
  markerHeight: 7,
  orient: "auto-start-reverse",
} as const;

/**
 * Marker id for an arrowhead, or undefined when there is no head to draw.
 *
 * `triangle` keeps the original bare id so documents and tests written before
 * connectors existed still resolve it; the other shapes are suffixed.
 *
 * Returns `undefined` rather than `null` because the live canvas spreads this
 * straight into a JSX `id` attribute, and React's prop types admit undefined but
 * not null.
 */
export function arrowMarkerId(
  arrow: ArrowType | undefined,
): string | undefined {
  if (!arrow || arrow === "none") return undefined;
  return arrow === "triangle" ? ARROW_MARKER_ID : `${ARROW_MARKER_ID}-${arrow}`;
}

function markerToString(arrow: Exclude<ArrowType, "none">): string {
  const shape = ARROW_MARKER_SHAPES[arrow];
  const shapeAttrs = Object.entries(shape.attrs)
    .map(([name, value]) => `${name}="${escapeXml(String(value))}"`)
    .join(" ");
  const boxAttrs = Object.entries(ARROW_MARKER_BOX)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return (
    `<marker id="${arrowMarkerId(arrow)}" ${boxAttrs}>` +
    `<${shape.element} ${shapeAttrs} /></marker>`
  );
}

/**
 * Marker definitions for exactly the arrowheads in use.
 *
 * Emitting only the used ones keeps a standalone file of plain lines from
 * carrying four dead defs. Omitting one that *is* referenced would silently drop
 * an arrowhead, which is the worse of the two failures, so this is derived from
 * the same list the paths are built from rather than maintained beside it.
 *
 * The live canvas does not call this: it renders every head unconditionally,
 * because in-memory defs cost nothing and a conditional set is one more thing
 * that can fall out of step with what the paths reference.
 */
export function arrowMarkerDefs(
  arrows: readonly (ArrowType | undefined)[],
): string {
  const used = new Set<Exclude<ArrowType, "none">>();
  for (const arrow of arrows) {
    if (arrow && arrow !== "none") used.add(arrow);
  }
  return [...used].map(markerToString).join("");
}

/**
 * Presentation attributes for a resolved connector.
 *
 * Shared by the live canvas and the export writer for the same reason
 * `shapeGeometry` is: a connector that renders as a curve on screen and a
 * straight line in the exported SVG is a fidelity failure the user only finds
 * after they have already sent the file.
 */
export function connectorAttrs(
  connector: Connector,
  resolved: ResolvedConnector,
  target: "dom" | "export",
): Record<string, string | number> {
  const { style } = connector;
  const attrs: Record<string, string | number> = {
    d: resolved.d,
    // A connector is stroke only; an inherited fill would paint the area between
    // the path's endpoints and turn an orthogonal route into a solid blob.
    fill: "none",
    stroke:
      resolveColor(style.stroke, target) ??
      (target === "dom" ? "var(--color-accent)" : "#1b1b1b"),
    "stroke-width": style.strokeWidth ?? 1,
  };

  if (style.opacity !== undefined && style.opacity !== 1) {
    attrs.opacity = style.opacity;
  }
  if (style.dashArray && style.dashArray.length > 0) {
    attrs["stroke-dasharray"] = style.dashArray.join(" ");
  }

  const start = arrowMarkerId(style.startArrow);
  const end = arrowMarkerId(style.endArrow);
  if (start) attrs["marker-start"] = `url(#${start})`;
  if (end) attrs["marker-end"] = `url(#${end})`;

  return attrs;
}

/** Size for a connector label whose TextContent carries no style of its own. */
const CONNECTOR_LABEL_FONT_SIZE = 12;

/**
 * Attributes for a connector's label.
 *
 * `ConnectorStyle` has no text block, so styling comes from the label's own
 * `TextContent.style` — the same `TextStyle` an object label uses. There is no
 * token-plus-hex pairing here, because `TextStyle.color` is a plain string
 * rather than a `ColorValue`; the fallback below is therefore what keeps an
 * exported label legible once the file leaves the app's stylesheet.
 *
 * `halo` is stroked *behind* the glyphs via `paint-order`. Without it the label
 * sits directly on the line it describes and the stroke runs through the text,
 * which is the single most common way edge labels end up unreadable.
 */
export function connectorLabelAttrs(
  label: TextContent,
  resolved: ResolvedConnector,
  target: "dom" | "export",
  halo: string,
): Record<string, string | number> {
  const textStyle = label.style;
  const color = textStyle?.color;
  return {
    x: resolved.labelAnchor.x,
    y: resolved.labelAnchor.y,
    fill:
      typeof color === "string" && color.length > 0
        ? color
        : target === "dom"
          ? "var(--color-text-primary)"
          : "#000000",
    stroke: halo,
    "stroke-width": 3,
    "stroke-linejoin": "round",
    "paint-order": "stroke",
    "font-size": textStyle?.fontSize ?? CONNECTOR_LABEL_FONT_SIZE,
    "text-anchor": "middle",
    "dominant-baseline": "middle",
  };
}

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
 * Vertices of the polygon-backed shapes, inscribed in the object's bounding box.
 *
 * Inscribing is not a stylistic choice: `objectBounds` reports the transform box,
 * and the selection outline, hit testing, marquee selection and export framing
 * all trust that box. A polygon drawn smaller than it would leave a visible gap
 * between the shape and its resize handles, and export would crop to air.
 */
function polygonPoints(
  type: "diamond" | "triangle",
  transform: Transform,
): string {
  const { x, y } = transform;
  const width = Math.max(transform.width, 0);
  const height = Math.max(transform.height, 0);
  const vertices: ReadonlyArray<readonly [number, number]> =
    type === "diamond"
      ? [
          [x + width / 2, y],
          [x + width, y + height / 2],
          [x + width / 2, y + height],
          [x, y + height / 2],
        ]
      : [
          [x + width / 2, y],
          [x + width, y + height],
          [x, y + height],
        ];
  return vertices.map(([px, py]) => `${px},${py}`).join(" ");
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

    case "diamond":
    case "triangle":
      return {
        element: "polygon",
        attrs: {
          ...shared,
          points: polygonPoints(object.type, transform),
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
      // A label is painted with the *text* colour, never the shape fill. Falling
      // back to `fill` here rendered labels in --color-background-surface: white
      // text on a near-white canvas, present in the DOM and hit-testable but
      // effectively invisible.
      const explicitColor = textStyle?.color;
      const textColor =
        typeof explicitColor === "string" && explicitColor.length > 0
          ? explicitColor
          : target === "dom"
            ? "var(--color-text-primary)"
            : "#000000";

      return {
        element: "text",
        attrs: {
          ...shared,
          fill: textColor,
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
