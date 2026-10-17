import type {
  ArrowType,
  BoundingBox,
  Connector,
  DiagramObject,
} from "../../document/model";
import { expandBounds, objectsBounds } from "../geometry";
import { resolveConnectors, type ResolvedConnector } from "../connectors";
import {
  arrowMarkerDefs,
  connectorAttrs,
  escapeXml,
  shapeGeometry,
} from "./shape-attrs";

export interface SvgExportOptions {
  /** "transparent" omits the backdrop rect entirely (FR-STYLE-07, FR-EXP-15). */
  background?: "transparent" | "white" | string;
  /** World units of margin around the content bounds. */
  padding?: number;
  /** Explicit bounds override; defaults to the content bounds. */
  bounds?: BoundingBox;
  /**
   * Connectors to draw, resolved against `objects`.
   *
   * They have to be serialised in the same call as the objects because a
   * connector's geometry is derived from the shapes it points at rather than
   * stored — there is nowhere else to resolve the endpoints against.
   */
  connectors?: readonly Connector[];
}

const DEFAULT_PADDING = 24;

function attributesToString(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .map(([name, value]) => `${name}="${escapeXml(String(value))}"`)
    .join(" ");
}

function renderObject(object: DiagramObject): string {
  const { element, attrs, lines } = shapeGeometry(object, "export");
  const open = `<${element} id="${escapeXml(object.id)}" ${attributesToString(attrs)}`;

  if (element === "text" && lines) {
    const x = attrs.x;
    const fontSize = Number(attrs["font-size"] ?? 14);
    // First line sits on the anchored baseline; later lines step down by the
    // font size so multiline labels (FR-TEXT-05) survive the export.
    const spans = lines
      .map(
        (line, index) =>
          `<tspan x="${escapeXml(String(x))}" dy="${index === 0 ? 0 : fontSize * 1.2}">${escapeXml(line)}</tspan>`,
      )
      .join("");
    return `${open}>${spans}</${element}>`;
  }

  return `${open} />`;
}

function renderConnector(
  connector: Connector,
  resolved: ResolvedConnector,
): string {
  const attrs = connectorAttrs(connector, resolved, "export");
  return `<path id="${escapeXml(connector.id)}" ${attributesToString(attrs)} />`;
}

/**
 * Writes a standalone SVG document (FR-EXP-02, FR-EXP-11, FR-EXP-12).
 *
 * Because the live canvas and this writer both go through `shapeGeometry`, the
 * exported file is the same picture the user was looking at. Object ids become
 * element ids, document order becomes paint order, and text stays text rather
 * than being flattened to paths (FR-TEXT-07).
 */
export function serializeObjectsToSvg(
  objects: readonly DiagramObject[],
  options: SvgExportOptions = {},
): string {
  const padding = options.padding ?? DEFAULT_PADDING;
  const content = options.bounds ?? objectsBounds(objects);
  const box = content
    ? expandBounds(content, padding)
    : { x: 0, y: 0, width: 100, height: 100 };

  const width = Math.max(Math.round(box.width), 1);
  const height = Math.max(Math.round(box.height), 1);

  const background = options.background ?? "transparent";
  const backgroundRect =
    background === "transparent"
      ? ""
      : `  <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${escapeXml(background)}" />\n`;

  const connectors = options.connectors ?? [];
  const resolved = resolveConnectors(connectors, objects);

  // Derive the marker list from what is actually referenced, by objects and by
  // connectors alike. An unused def is harmless noise; a missing one silently
  // drops every arrowhead pointing at it, which is the worse failure and the
  // easier one to ship by accident.
  const arrowTypes: (ArrowType | undefined)[] = [];
  if (objects.some((object) => object.type === "arrow")) {
    arrowTypes.push("triangle");
  }
  for (const connector of connectors) {
    arrowTypes.push(connector.style.startArrow, connector.style.endArrow);
  }
  const markers = arrowMarkerDefs(arrowTypes);
  const defs = markers ? `  <defs>${markers}</defs>` : "";

  const body = objects.map((object) => `  ${renderObject(object)}`).join("\n");

  // Connectors paint after objects so an arrowhead meeting a shape's perimeter is
  // not half-covered by the shape it points at. Anchors are clipped to the
  // perimeter, so a path never extends past the objects' own bounds and the
  // framing computed above still holds without widening for connectors.
  const connectorBody = connectors
    .filter((connector) => connector.visible)
    .map((connector) => {
      const path = resolved.get(connector.id);
      return path ? `  ${renderConnector(connector, path)}` : "";
    })
    .filter((line) => line.length > 0)
    .join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}">`,
    defs,
    backgroundRect.replace(/\n$/, ""),
    body,
    connectorBody,
    "</svg>",
    "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
