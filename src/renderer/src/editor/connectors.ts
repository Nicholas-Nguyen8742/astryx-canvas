import type {
  BoundingBox,
  Connector,
  ConnectorEndpoint,
  DiagramObject,
  Point,
} from "../document/model";
import { objectBounds, portWorldPoint } from "./geometry";

/**
 * Connector path resolution.
 *
 * A connector's endpoints are defined *relative to objects* — an object id plus
 * an optional port — rather than as absolute coordinates. That is what makes a
 * connector follow a shape when the shape is dragged, and it means the path has
 * to be recomputed on every move rather than stored.
 *
 * The recomputation lives here, pure and in one place, so the live canvas, the
 * export writer and the tests cannot resolve the same connector into three
 * different curves. This is the same argument that put `shapeGeometry` behind a
 * single function.
 */

export interface ResolvedConnector {
  /** World-space anchor at the source end, where the start arrowhead sits. */
  start: Point;
  /** World-space anchor at the target end, where the end arrowhead sits. */
  end: Point;
  /** SVG path data in world coordinates, ready for a `<path d>`. */
  d: string;
}

/**
 * Indexes objects by id so resolving N connectors against M objects costs N
 * lookups instead of N*M scans. Built once per frame or per export, not per
 * connector.
 */
export function indexObjects(
  objects: readonly DiagramObject[],
): ReadonlyMap<string, DiagramObject> {
  return new Map(objects.map((object) => [object.id, object]));
}

/**
 * Where a connector's edge meets an object's perimeter, on the line from the
 * object's centre toward `toward`.
 *
 * Used when an endpoint names an object but no port. Clipping to the perimeter
 * rather than connecting centres is what stops an arrowhead from being buried
 * under the shape it points at, and it keeps the attachment stable as the other
 * end moves instead of snapping between a fixed set of edge midpoints.
 */
export function perimeterPoint(box: BoundingBox, toward: Point): Point {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const dx = toward.x - centerX;
  const dy = toward.y - centerY;

  // Both deltas zero means the target is the centre itself, so there is no
  // direction to clip along; returning the centre keeps the caller total
  // instead of producing NaN that would poison the whole path.
  if (dx === 0 && dy === 0) return { x: centerX, y: centerY };

  // A zero delta on one axis means the ray is parallel to that pair of edges and
  // never crosses them, so that axis imposes no limit.
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : box.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : box.height / 2 / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);

  return { x: centerX + dx * scale, y: centerY + dy * scale };
}

function resolveEndpoint(
  endpoint: ConnectorEndpoint,
  index: ReadonlyMap<string, DiagramObject>,
  other: Point,
): Point | null {
  const object = index.get(endpoint.objectId);

  // An explicit port wins: the user pinned the connector to a named attachment
  // point, and inferring a perimeter crossing would silently move it.
  if (object && endpoint.portId) {
    const port = object.ports?.find((candidate) => candidate.id === endpoint.portId);
    if (port) return portWorldPoint(object.transform, port);
  }

  if (object) return perimeterPoint(objectBounds(object), other);

  // The object is gone — deleted, or a document referencing something that was
  // never there. A stored fallback point keeps the connector drawable; without
  // one there is nothing to anchor to and the caller drops the connector rather
  // than drawing a line to the origin.
  return endpoint.fallbackPoint ? { ...endpoint.fallbackPoint } : null;
}

function centerOf(
  endpoint: ConnectorEndpoint,
  index: ReadonlyMap<string, DiagramObject>,
): Point | null {
  const object = index.get(endpoint.objectId);
  if (object) {
    const box = objectBounds(object);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  return endpoint.fallbackPoint ? { ...endpoint.fallbackPoint } : null;
}

function format(value: number): string {
  // Trim the float noise a rotated transform produces without rounding the
  // geometry enough to be visible: 3 decimal places is a thousandth of a world
  // unit, far below a pixel at any zoom the app allows.
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, "");
}

function straightPath(start: Point, end: Point): string {
  return `M ${format(start.x)} ${format(start.y)} L ${format(end.x)} ${format(end.y)}`;
}

function orthogonalPath(start: Point, end: Point): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const mid = format(Math.abs(dx) >= Math.abs(dy) ? start.x + dx / 2 : start.y + dy / 2);

  // Run along the dominant axis first, turn once at the midpoint, then run along
  // the other. Turning at the midpoint rather than at the corner keeps the two
  // halves balanced as either object is dragged.
  const [x1, y1] = [format(start.x), format(start.y)];
  const [x2, y2] = [format(end.x), format(end.y)];
  return Math.abs(dx) >= Math.abs(dy)
    ? `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2} ${y2}`
    : `M ${x1} ${y1} L ${x1} ${mid} L ${x2} ${mid} L ${x2} ${y2}`;
}

function curvedPath(start: Point, end: Point): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Control points pushed along the dominant axis, which is what makes the curve
  // leave each anchor square-on instead of hooking sideways out of it.
  const [c1, c2] =
    Math.abs(dx) >= Math.abs(dy)
      ? [
          { x: start.x + dx / 2, y: start.y },
          { x: end.x - dx / 2, y: end.y },
        ]
      : [
          { x: start.x, y: start.y + dy / 2 },
          { x: end.x, y: end.y - dy / 2 },
        ];
  return (
    `M ${format(start.x)} ${format(start.y)} ` +
    `C ${format(c1.x)} ${format(c1.y)} ${format(c2.x)} ${format(c2.y)} ` +
    `${format(end.x)} ${format(end.y)}`
  );
}

/**
 * Resolves one connector to world-space path data.
 *
 * Returns `null` when either endpoint names an object that is not present and
 * carries no fallback point. Dropping such a connector is correct: drawing it to
 * the origin would invent an edge the user never authored, and a dangling
 * connector is a document-integrity problem to surface on load, not something to
 * paper over at render time.
 */
export function resolveConnector(
  connector: Connector,
  index: ReadonlyMap<string, DiagramObject>,
): ResolvedConnector | null {
  // Anchors are resolved against the *other* endpoint's centre rather than its
  // final anchor. Using the final anchor would be circular — each end depends on
  // the other — and the centre is a stable approximation that does not oscillate
  // as the objects move.
  const sourceAim = centerOf(connector.target, index);
  const targetAim = centerOf(connector.source, index);
  if (!sourceAim || !targetAim) return null;

  const start = resolveEndpoint(connector.source, index, sourceAim);
  const end = resolveEndpoint(connector.target, index, targetAim);
  if (!start || !end) return null;

  const d =
    connector.routing === "orthogonal"
      ? orthogonalPath(start, end)
      : connector.routing === "curved"
        ? curvedPath(start, end)
        : straightPath(start, end);

  return { start, end, d };
}

/** Resolves every connector against one shared index. */
export function resolveConnectors(
  connectors: readonly Connector[],
  objects: readonly DiagramObject[],
): Map<string, ResolvedConnector> {
  const index = indexObjects(objects);
  const resolved = new Map<string, ResolvedConnector>();
  for (const connector of connectors) {
    const path = resolveConnector(connector, index);
    if (path) resolved.set(connector.id, path);
  }
  return resolved;
}
