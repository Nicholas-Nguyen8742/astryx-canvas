import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  MIN_ZOOM,
  boundsOfAll,
  boundsUnion,
  clamp,
  clampZoom,
  containsBounds,
  containsPoint,
  distance,
  distanceToSegment,
  expandBounds,
  fitViewport,
  intersects,
  objectBounds,
  panByScreen,
  portWorldPoint,
  screenToWorld,
  snapBounds,
  snapPoint,
  snapValue,
  transformBounds,
  worldToScreen,
  zoomAt,
  zoomAtCenter,
} from "../../src/renderer/src/editor/geometry";
import type { Transform, Viewport } from "../../src/renderer/src/document/model";

const ORIGIN: Viewport = { x: 0, y: 0, zoom: 1 };

function transform(overrides: Partial<Transform> = {}): Transform {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    ...overrides,
  };
}

describe("clampZoom", () => {
  it("clamps to the 10%-800% range required by FR-CANVAS-04", () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
    expect(MIN_ZOOM).toBe(0.1);
    expect(MAX_ZOOM).toBe(8);
  });

  it("rejects non-finite and non-positive zoom instead of propagating NaN", () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-2)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_ZOOM);
  });
});

describe("coordinate conversion", () => {
  it("round-trips world -> screen -> world exactly", () => {
    const viewport: Viewport = { x: 120, y: -45, zoom: 2.5 };
    const world = { x: 340.25, y: 78.5 };
    const back = screenToWorld(worldToScreen(world, viewport), viewport);
    expect(back.x).toBeCloseTo(world.x, 10);
    expect(back.y).toBeCloseTo(world.y, 10);
  });

  it("round-trips at the zoom extremes", () => {
    for (const zoom of [MIN_ZOOM, MAX_ZOOM]) {
      const viewport: Viewport = { x: -1000, y: 5000, zoom };
      const world = { x: 12.5, y: -7.25 };
      const back = screenToWorld(worldToScreen(world, viewport), viewport);
      expect(back.x).toBeCloseTo(world.x, 6);
      expect(back.y).toBeCloseTo(world.y, 6);
    }
  });

  it("maps the viewport origin to the screen origin", () => {
    const viewport: Viewport = { x: 33, y: 77, zoom: 3 };
    expect(worldToScreen({ x: 33, y: 77 }, viewport)).toEqual({ x: 0, y: 0 });
    expect(screenToWorld({ x: 0, y: 0 }, ORIGIN)).toEqual({ x: 0, y: 0 });
  });
});

describe("panByScreen", () => {
  it("moves the world origin opposite to the drag, scaled by zoom", () => {
    const viewport: Viewport = { x: 0, y: 0, zoom: 2 };
    expect(panByScreen(viewport, 100, -40)).toEqual({ x: -50, y: 20, zoom: 2 });
  });

  it("preserves zoom", () => {
    expect(panByScreen({ x: 5, y: 5, zoom: 4 }, 10, 10).zoom).toBe(4);
  });
});

describe("zoomAt", () => {
  it("keeps the world point under the anchor visually stationary", () => {
    const viewport: Viewport = { x: 100, y: 50, zoom: 1 };
    const anchor = { x: 320, y: 240 };
    const before = screenToWorld(anchor, viewport);

    for (const factor of [1.5, 0.5, 3, 0.1]) {
      const zoomed = zoomAt(viewport, anchor, factor);
      const after = screenToWorld(anchor, zoomed);
      expect(after.x).toBeCloseTo(before.x, 10);
      expect(after.y).toBeCloseTo(before.y, 10);
    }
  });

  it("holds the anchor across a long chain of zoom steps without drift", () => {
    const anchor = { x: 412, y: 289 };
    let viewport: Viewport = { x: 0, y: 0, zoom: 1 };
    const anchorWorld = screenToWorld(anchor, viewport);

    for (let step = 0; step < 200; step += 1) {
      viewport = zoomAt(viewport, anchor, step % 2 === 0 ? 1.1 : 1 / 1.1);
    }

    const settled = screenToWorld(anchor, viewport);
    expect(settled.x).toBeCloseTo(anchorWorld.x, 6);
    expect(settled.y).toBeCloseTo(anchorWorld.y, 6);
  });

  it("returns the same viewport when the zoom is already at a limit", () => {
    const maxed: Viewport = { x: 10, y: 10, zoom: MAX_ZOOM };
    expect(zoomAt(maxed, { x: 5, y: 5 }, 2)).toBe(maxed);
  });

  it("zooms about the centre for zoomAtCenter", () => {
    const size = { x: 800, y: 600 };
    const viewport: Viewport = { x: 0, y: 0, zoom: 1 };
    const centre = { x: 400, y: 300 };
    const before = screenToWorld(centre, viewport);
    const zoomed = zoomAtCenter(viewport, size, 2);
    const after = screenToWorld(centre, zoomed);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    expect(zoomed.zoom).toBe(2);
  });
});

describe("fitViewport", () => {
  it("frames content with padding and stays within the zoom limits", () => {
    const viewport = fitViewport({ x: 0, y: 0, width: 1000, height: 500 }, { x: 800, y: 600 }, 48);
    expect(viewport.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    expect(viewport.zoom).toBeGreaterThan(0);
    // Content is wider relative to the frame, so width is the binding axis.
    expect(viewport.zoom).toBeCloseTo((800 - 96) / 1000, 10);
  });

  it("centres the content in the viewport", () => {
    const content = { x: 100, y: 100, width: 200, height: 200 };
    const size = { x: 1000, y: 1000 };
    const viewport = fitViewport(content, size, 0);
    const centreScreen = worldToScreen({ x: 200, y: 200 }, viewport);
    expect(centreScreen.x).toBeCloseTo(500, 6);
    expect(centreScreen.y).toBeCloseTo(500, 6);
  });

  it("falls back to the origin at 100% for empty or degenerate content", () => {
    for (const content of [
      null,
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 5, y: 5, width: -10, height: 20 },
    ]) {
      const viewport = fitViewport(content, { x: 800, y: 600 });
      expect(viewport.zoom).toBe(1);
      expect(Number.isFinite(viewport.x)).toBe(true);
      expect(Number.isFinite(viewport.y)).toBe(true);
    }
  });

  it("never divides by zero when padding exceeds the viewport", () => {
    const viewport = fitViewport({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20 }, 500);
    expect(Number.isFinite(viewport.zoom)).toBe(true);
    expect(viewport.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  });
});

describe("bounds algebra", () => {
  it("unions overlapping and disjoint boxes", () => {
    expect(boundsUnion({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }))
      .toEqual({ x: 0, y: 0, width: 15, height: 15 });
    expect(boundsUnion({ x: 0, y: 0, width: 5, height: 5 }, { x: 100, y: 100, width: 5, height: 5 }))
      .toEqual({ x: 0, y: 0, width: 105, height: 105 });
  });

  it("returns null for an empty set and the single box for one entry", () => {
    expect(boundsOfAll([])).toBeNull();
    const only = { x: 1, y: 2, width: 3, height: 4 };
    expect(boundsOfAll([only])).toEqual(only);
  });

  it("expands symmetrically on every edge", () => {
    expect(expandBounds({ x: 10, y: 10, width: 20, height: 20 }, 5)).toEqual({
      x: 5,
      y: 5,
      width: 30,
      height: 30,
    });
  });
});

describe("hit testing predicates", () => {
  const box = { x: 0, y: 0, width: 100, height: 100 };

  it("detects intersection on all four edges and rejects separation", () => {
    expect(intersects(box, { x: 90, y: 90, width: 50, height: 50 })).toBe(true);
    expect(intersects(box, { x: -40, y: 20, width: 50, height: 10 })).toBe(true);
    expect(intersects(box, { x: 200, y: 200, width: 10, height: 10 })).toBe(false);
  });

  it("treats edge-touching boxes as non-intersecting", () => {
    expect(intersects(box, { x: 100, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it("includes the boundary for containsPoint", () => {
    expect(containsPoint(box, { x: 0, y: 0 })).toBe(true);
    expect(containsPoint(box, { x: 100, y: 100 })).toBe(true);
    expect(containsPoint(box, { x: 101, y: 50 })).toBe(false);
  });

  it("requires full enclosure for containsBounds", () => {
    expect(containsBounds(box, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
    expect(containsBounds(box, { x: -1, y: 10, width: 20, height: 20 })).toBe(false);
    expect(containsBounds(box, { x: 10, y: 10, width: 200, height: 20 })).toBe(false);
  });
});

describe("distanceToSegment", () => {
  it("returns the perpendicular distance inside the segment span", () => {
    expect(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 10);
  });

  it("clamps to the nearest endpoint outside the span", () => {
    expect(distanceToSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 10);
    expect(distanceToSegment({ x: 15, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 10);
  });

  it("degrades to point distance for a zero-length segment", () => {
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5, 10);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 10);
  });
});

describe("snapping", () => {
  it("snaps to the nearest grid step", () => {
    expect(snapValue(14, 10)).toBe(10);
    expect(snapValue(16, 10)).toBe(20);
    expect(snapValue(-14, 10)).toBe(-10);
  });

  it("passes values through when the grid is disabled", () => {
    expect(snapValue(14.7, 0)).toBe(14.7);
    expect(snapPoint({ x: 1.5, y: 2.5 }, 0)).toEqual({ x: 1.5, y: 2.5 });
  });

  it("snaps both axes and keeps a box at least one grid step in size", () => {
    expect(snapPoint({ x: 14, y: 26 }, 10)).toEqual({ x: 10, y: 30 });
    expect(snapBounds({ x: 14, y: 26, width: 3, height: 140 }, 10)).toEqual({
      x: 10,
      y: 30,
      width: 10,
      height: 140,
    });
  });
});

describe("transformBounds", () => {
  it("returns the unrotated box when rotation is zero", () => {
    expect(transformBounds(transform({ x: 10, y: 20, width: 100, height: 50 }))).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("swaps width and height at 90 degrees about the centre", () => {
    const box = transformBounds(transform({ x: 0, y: 0, width: 100, height: 50, rotation: 90 }));
    expect(box.width).toBeCloseTo(50, 6);
    expect(box.height).toBeCloseTo(100, 6);
    // Centre must not move under rotation.
    expect(box.x + box.width / 2).toBeCloseTo(50, 6);
    expect(box.y + box.height / 2).toBeCloseTo(25, 6);
  });

  it("grows the bounding box at 45 degrees", () => {
    const box = transformBounds(transform({ x: 0, y: 0, width: 100, height: 100, rotation: 45 }));
    const expected = 100 * Math.SQRT2;
    expect(box.width).toBeCloseTo(expected, 6);
    expect(box.height).toBeCloseTo(expected, 6);
  });

  it("is invariant across a full turn", () => {
    const atZero = transformBounds(transform({ rotation: 0 }));
    const atFull = transformBounds(transform({ rotation: 360 }));
    expect(atFull.x).toBeCloseTo(atZero.x, 6);
    expect(atFull.width).toBeCloseTo(atZero.width, 6);
  });

  it("exposes objectBounds for a diagram object", () => {
    const object = {
      id: "o1",
      type: "rectangle" as const,
      zIndex: 1,
      visible: true,
      locked: false,
      transform: transform({ x: 5, y: 6, width: 10, height: 10 }),
      style: {},
    };
    expect(objectBounds(object)).toEqual({ x: 5, y: 6, width: 10, height: 10 });
  });
});

describe("portWorldPoint", () => {
  it("resolves normalised port coordinates against the unrotated box", () => {
    const t = transform({ x: 100, y: 100, width: 200, height: 100 });
    expect(portWorldPoint(t, { x: 0, y: 0 })).toEqual({ x: 100, y: 100 });
    expect(portWorldPoint(t, { x: 1, y: 1 })).toEqual({ x: 300, y: 200 });
    expect(portWorldPoint(t, { x: 0.5, y: 0 })).toEqual({ x: 200, y: 100 });
    expect(portWorldPoint(t, { x: 0, y: 0.5 })).toEqual({ x: 100, y: 150 });
  });

  it("rotates ports with the object so connectors stay attached", () => {
    const t = transform({ x: 0, y: 0, width: 200, height: 100, rotation: 90 });
    // The top-centre port swings to the right of centre under a 90 degree turn.
    const port = portWorldPoint(t, { x: 0.5, y: 0 });
    expect(port.x).toBeCloseTo(150, 6);
    expect(port.y).toBeCloseTo(50, 6);
  });

  it("keeps ports equidistant from the centre under rotation", () => {
    const unrotated = transform({ x: 0, y: 0, width: 200, height: 100, rotation: 0 });
    const rotated = transform({ x: 0, y: 0, width: 200, height: 100, rotation: 37 });
    const centre = { x: 100, y: 50 };
    const before = portWorldPoint(unrotated, { x: 1, y: 1 });
    const after = portWorldPoint(rotated, { x: 1, y: 1 });
    expect(distance(before, centre)).toBeCloseTo(distance(after, centre), 6);
  });
});

describe("clamp", () => {
  it("clamps both ends and passes through in-range values", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
