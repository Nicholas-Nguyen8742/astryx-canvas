import type {
  BoundingBox,
  DiagramObject,
  Point,
  Transform,
  Viewport,
} from "../../document/model";

/**
 * World/screen coordinate algebra (TRD §14.1).
 *
 * One convention holds everywhere: `viewport.x`/`viewport.y` is the *world* point
 * that sits at the top-left of the canvas element, and `zoom` scales world units
 * to device-independent pixels. So
 *
 *   screen = (world - viewportOrigin) * zoom
 *   world  = screen / zoom + viewportOrigin
 *
 * Keeping the origin in world space (rather than storing a pixel offset) is what
 * makes `zoomAt` exact: anchoring a zoom on the cursor is one solved equation
 * instead of a correction applied after the fact, so object positions cannot
 * drift across repeated zoom steps (FR-CANVAS-12).
 */

/** FR-CANVAS-04: at least 10% to 800%. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clampZoom(zoom: number): number {
  // NaN and -Infinity are nonsense inputs and collapse to the floor, but
  // +Infinity is a meaningful "zoom in as far as possible" and must reach the
  // ceiling. `clamp` already handles it correctly, so only NaN needs a guard.
  if (Number.isNaN(zoom)) return MIN_ZOOM;
  if (zoom <= 0) return MIN_ZOOM;
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

export function point(x: number, y: number): Point {
  return { x, y };
}

export function bounds(
  x: number,
  y: number,
  width: number,
  height: number,
): BoundingBox {
  return { x, y, width, height };
}

export function worldToScreen(p: Point, viewport: Viewport): Point {
  return {
    x: (p.x - viewport.x) * viewport.zoom,
    y: (p.y - viewport.y) * viewport.zoom,
  };
}

export function screenToWorld(p: Point, viewport: Viewport): Point {
  return {
    x: p.x / viewport.zoom + viewport.x,
    y: p.y / viewport.zoom + viewport.y,
  };
}

/** Pan by a delta expressed in screen pixels, e.g. from a pointer drag. */
export function panByScreen(
  viewport: Viewport,
  dxScreen: number,
  dyScreen: number,
): Viewport {
  return {
    x: viewport.x - dxScreen / viewport.zoom,
    y: viewport.y - dyScreen / viewport.zoom,
    zoom: viewport.zoom,
  };
}

/**
 * Scale about a fixed screen anchor, keeping the world point under that anchor
 * visually stationary. This is what makes wheel and pinch zoom feel attached to
 * the cursor rather than to the canvas corner (FR-CANVAS-03).
 */
export function zoomAt(
  viewport: Viewport,
  anchorScreen: Point,
  factor: number,
): Viewport {
  const nextZoom = clampZoom(viewport.zoom * factor);
  if (nextZoom === viewport.zoom) return viewport;

  const anchorWorld = screenToWorld(anchorScreen, viewport);
  return {
    x: anchorWorld.x - anchorScreen.x / nextZoom,
    y: anchorWorld.y - anchorScreen.y / nextZoom,
    zoom: nextZoom,
  };
}

/** Zoom about the centre of a viewport of the given size. */
export function zoomAtCenter(
  viewport: Viewport,
  viewportSize: Point,
  factor: number,
): Viewport {
  return zoomAt(
    viewport,
    { x: viewportSize.x / 2, y: viewportSize.y / 2 },
    factor,
  );
}

/**
 * Fit content into view (FR-CANVAS-08). Empty or degenerate content falls back
 * to the origin at 100% rather than dividing by zero into an infinite zoom.
 */
export function fitViewport(
  content: BoundingBox | null,
  viewportSize: Point,
  padding = 48,
): Viewport {
  const availableWidth = Math.max(viewportSize.x - padding * 2, 1);
  const availableHeight = Math.max(viewportSize.y - padding * 2, 1);

  if (!content || content.width <= 0 || content.height <= 0) {
    return {
      x: -viewportSize.x / 2,
      y: -viewportSize.y / 2,
      zoom: 1,
    };
  }

  const zoom = clampZoom(
    Math.min(availableWidth / content.width, availableHeight / content.height),
  );
  return {
    x: content.x + content.width / 2 - viewportSize.x / 2 / zoom,
    y: content.y + content.height / 2 - viewportSize.y / 2 / zoom,
    zoom,
  };
}

export function boundsUnion(a: BoundingBox, b: BoundingBox): BoundingBox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function boundsOfAll(boxes: readonly BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null;
  const [first, ...rest] = boxes;
  if (!first) return null;
  return rest.reduce<BoundingBox>((acc, box) => boundsUnion(acc, box), first);
}

export function expandBounds(box: BoundingBox, amount: number): BoundingBox {
  return {
    x: box.x - amount,
    y: box.y - amount,
    width: box.width + amount * 2,
    height: box.height + amount * 2,
  };
}

export function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function containsPoint(box: BoundingBox, p: Point): boolean {
  return (
    p.x >= box.x &&
    p.x <= box.x + box.width &&
    p.y >= box.y &&
    p.y <= box.y + box.height
  );
}

export function containsBounds(
  outer: BoundingBox,
  inner: BoundingBox,
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Shortest distance from a point to a line segment, used for hit testing
 * stroke-only objects and connector lines where there is no filled area to
 * test against (TRD §14.2).
 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(p, a);

  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1);
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

export function snapValue(value: number, gridSize: number): number {
  if (gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

export function snapPoint(p: Point, gridSize: number): Point {
  return { x: snapValue(p.x, gridSize), y: snapValue(p.y, gridSize) };
}

export function snapBounds(box: BoundingBox, gridSize: number): BoundingBox {
  return {
    x: snapValue(box.x, gridSize),
    y: snapValue(box.y, gridSize),
    width: Math.max(snapValue(box.width, gridSize), gridSize),
    height: Math.max(snapValue(box.height, gridSize), gridSize),
  };
}

/**
 * Axis-aligned bounds of a possibly rotated object.
 *
 * Rotation is about the object's centre, matching how the resize handles and the
 * selection outline are drawn, so the four rotated corners are projected and
 * reduced rather than assuming the unrotated rectangle.
 */
export function transformBounds(transform: Transform): BoundingBox {
  if (transform.rotation === 0) {
    return {
      x: transform.x,
      y: transform.y,
      width: transform.width,
      height: transform.height,
    };
  }

  const radians = (transform.rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = transform.x + transform.width / 2;
  const centerY = transform.y + transform.height / 2;
  const halfWidth = transform.width / 2;
  const halfHeight = transform.height / 2;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const signX of [-1, 1]) {
    for (const signY of [-1, 1]) {
      const localX = signX * halfWidth;
      const localY = signY * halfHeight;
      const worldX = centerX + localX * cosine - localY * sine;
      const worldY = centerY + localX * sine + localY * cosine;
      minX = Math.min(minX, worldX);
      minY = Math.min(minY, worldY);
      maxX = Math.max(maxX, worldX);
      maxY = Math.max(maxY, worldY);
    }
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function objectBounds(object: DiagramObject): BoundingBox {
  return transformBounds(object.transform);
}

export function objectsBounds(
  objects: readonly DiagramObject[],
): BoundingBox | null {
  return boundsOfAll(objects.map(objectBounds));
}

export function boundsCenter(box: BoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Resolve a stencil port to a world point. Port coordinates are normalised 0..1
 * against the object's unrotated box (TRD §11.3), then rotated with the object so
 * connectors stay attached to the correct edge after a rotation.
 */
export function portWorldPoint(transform: Transform, port: Point): Point {
  const localX = (port.x - 0.5) * transform.width;
  const localY = (port.y - 0.5) * transform.height;

  if (transform.rotation === 0) {
    return {
      x: transform.x + localX + transform.width / 2,
      y: transform.y + localY + transform.height / 2,
    };
  }

  const radians = (transform.rotation * Math.PI) / 180;
  const centerX = transform.x + transform.width / 2;
  const centerY = transform.y + transform.height / 2;
  return {
    x: centerX + localX * Math.cos(radians) - localY * Math.sin(radians),
    y: centerY + localX * Math.sin(radians) + localY * Math.cos(radians),
  };
}

/** Which edge or corner of an object's box a resize is dragging. */
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/**
 * Smallest box a resize may produce. Without a floor, dragging a handle past its
 * anchor leaves an object too small to select again — effectively undeletable
 * through the UI.
 */
export const MIN_OBJECT_SIZE = 4;

export interface ResizeConstraints {
  /**
   * Keep the result square, so one side drives both axes.
   *
   * Required by `circle`: its type asserts a property its transform would
   * otherwise be free to violate, and a shape that stops being round while still
   * claiming to be a circle is a defect no renderer can detect, because every
   * layer downstream faithfully draws the box it is given.
   */
  square?: boolean;
}

/**
 * Resizes from a dragged handle while keeping the opposite edge anchored, and
 * refuses to invert: dragging past the anchor clamps rather than flipping, which
 * is what makes a resize feel predictable.
 *
 * Under `square`, the longer axis wins — the same rule the circle's drag-create
 * gesture uses, so drawing one and then resizing it cannot disagree about what a
 * circle is. The dragged edge still follows the pointer and the opposite edge
 * stays anchored; on the axis that was not dragged, growth is symmetric about the
 * centre so the shape stays under the cursor instead of sliding away from it.
 */
export function resizeTransform(
  from: Transform,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  constraints: ResizeConstraints = {},
): Transform {
  let left = from.x;
  let top = from.y;
  let right = from.x + from.width;
  let bottom = from.y + from.height;

  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;

  if (constraints.square) {
    const side = Math.max(right - left, bottom - top, MIN_OBJECT_SIZE);

    if (handle.includes("e")) right = left + side;
    else if (handle.includes("w")) left = right - side;
    else {
      const centerX = (left + right) / 2;
      left = centerX - side / 2;
      right = centerX + side / 2;
    }

    if (handle.includes("s")) bottom = top + side;
    else if (handle.includes("n")) top = bottom - side;
    else {
      const centerY = (top + bottom) / 2;
      top = centerY - side / 2;
      bottom = centerY + side / 2;
    }
  } else {
    if (right - left < MIN_OBJECT_SIZE) {
      if (handle.includes("w")) left = right - MIN_OBJECT_SIZE;
      else right = left + MIN_OBJECT_SIZE;
    }
    if (bottom - top < MIN_OBJECT_SIZE) {
      if (handle.includes("n")) top = bottom - MIN_OBJECT_SIZE;
      else bottom = top + MIN_OBJECT_SIZE;
    }
  }

  return {
    ...from,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}
