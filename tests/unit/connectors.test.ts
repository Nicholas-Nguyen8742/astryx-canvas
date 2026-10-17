import { describe, expect, it } from "vitest";

import {
  indexObjects,
  perimeterPoint,
  resolveConnector,
  resolveConnectors,
} from "../../src/renderer/src/editor/connectors";
import {
  createObject,
  identityTransform,
} from "../../src/renderer/src/editor/factories";
import { objectBounds } from "../../src/renderer/src/editor/geometry";
import type {
  Connector,
  DiagramObject,
  PortInstance,
} from "../../src/renderer/src/document/model";

/**
 * Connector endpoints are relative to objects, so the interesting behaviour is
 * all about *where the path attaches*: on the perimeter, at a pinned port, or at
 * a stored fallback. The routing strings are the easy part.
 */

function box(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 100,
  ports?: PortInstance[],
): DiagramObject {
  const object = createObject(
    "rectangle",
    identityTransform(x, y, width, height),
  );
  return ports ? { ...object, id, ports } : { ...object, id };
}

function connector(overrides: Partial<Connector> = {}): Connector {
  return {
    id: "conn-1",
    source: { objectId: "a" },
    target: { objectId: "b" },
    routing: "straight",
    style: { stroke: { hex: "#000000" }, strokeWidth: 2, opacity: 1 },
    zIndex: 0,
    visible: true,
    locked: false,
    ...overrides,
  };
}

/** A at the origin, B directly to its right, both 100x100. */
const SIDE_BY_SIDE = [box("a", 0, 0), box("b", 200, 0)];

describe("perimeterPoint", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };

  it("clips to the edge midpoint when the target is square on an axis", () => {
    expect(perimeterPoint(bounds, { x: 250, y: 50 })).toEqual({
      x: 100,
      y: 50,
    });
    expect(perimeterPoint(bounds, { x: -250, y: 50 })).toEqual({ x: 0, y: 50 });
    expect(perimeterPoint(bounds, { x: 50, y: 250 })).toEqual({
      x: 50,
      y: 100,
    });
    expect(perimeterPoint(bounds, { x: 50, y: -250 })).toEqual({ x: 50, y: 0 });
  });

  it("clips a diagonal to the corner it exits through", () => {
    expect(perimeterPoint(bounds, { x: 250, y: 250 })).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("clips to whichever edge the ray reaches first, not always the corner", () => {
    // Shallow angle: the ray crosses the right edge well inside the box's height.
    // dx 400 against dy 100 from the centre, so the horizontal limit binds and
    // the crossing is a quarter of the way up, not three quarters.
    const point = perimeterPoint(bounds, { x: 450, y: 150 });
    expect(point.x).toBeCloseTo(100, 6);
    expect(point.y).toBeCloseTo(62.5, 6);
  });

  it("returns the centre rather than NaN when the target is the centre", () => {
    // A degenerate direction must not poison every coordinate downstream.
    expect(perimeterPoint(bounds, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
  });

  it("handles a zero-height box without dividing by zero", () => {
    const flat = { x: 0, y: 50, width: 100, height: 0 };
    const point = perimeterPoint(flat, { x: 250, y: 50 });
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
    expect(point.x).toBeCloseTo(100, 6);
  });
});

describe("resolveConnector — anchoring", () => {
  it("attaches to the facing edges of two shapes", () => {
    const resolved = resolveConnector(connector(), indexObjects(SIDE_BY_SIDE));
    expect(resolved).not.toBeNull();
    expect(resolved!.start).toEqual({ x: 100, y: 50 });
    expect(resolved!.end).toEqual({ x: 200, y: 50 });
  });

  it("emits exact integers when the geometry is integral", () => {
    // Guards the number formatting: a path full of 100.000 is noise in a saved
    // file and in a diff.
    const resolved = resolveConnector(connector(), indexObjects(SIDE_BY_SIDE));
    expect(resolved!.d).toBe("M 100 50 L 200 50");
  });

  it("pins to a named port and ignores where the other end is", () => {
    const topPort: PortInstance[] = [{ id: "top", x: 0.5, y: 0 }];
    const objects = [box("a", 0, 0, 100, 100, topPort), box("b", 400, 300)];
    const resolved = resolveConnector(
      connector({ source: { objectId: "a", portId: "top" } }),
      indexObjects(objects),
    );
    // The port is the top-centre of A no matter how far B moves.
    expect(resolved!.start).toEqual({ x: 50, y: 0 });
  });

  it("falls back to the perimeter when a named port does not exist", () => {
    const resolved = resolveConnector(
      connector({ source: { objectId: "a", portId: "nope" } }),
      indexObjects(SIDE_BY_SIDE),
    );
    expect(resolved!.start).toEqual({ x: 100, y: 50 });
  });

  it("moves a port with its object under rotation", () => {
    const rightPort: PortInstance[] = [{ id: "right", x: 1, y: 0.5 }];
    const rotated: DiagramObject = {
      ...box("a", 0, 0, 100, 100, rightPort),
      transform: { ...identityTransform(0, 0, 100, 100), rotation: 90 },
    };
    const objects = [rotated, box("b", 400, 400)];
    const resolved = resolveConnector(
      connector({ source: { objectId: "a", portId: "right" } }),
      indexObjects(objects),
    );
    // Rotated 90 degrees about the centre, the right-edge port lands on the
    // bottom edge. If it did not, connectors would detach on every rotation.
    expect(resolved!.start.x).toBeCloseTo(50, 6);
    expect(resolved!.start.y).toBeCloseTo(100, 6);
  });

  it("uses a stored fallback point when the source object is gone", () => {
    const objects = [box("b", 200, 0)];
    const resolved = resolveConnector(
      connector({
        source: { objectId: "missing", fallbackPoint: { x: 10, y: 50 } },
      }),
      indexObjects(objects),
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.start).toEqual({ x: 10, y: 50 });
    // The surviving end still anchors to its own perimeter.
    expect(resolved!.end.x).toBeCloseTo(200, 6);
    expect(resolved!.end.y).toBeCloseTo(50, 6);
  });

  it("returns null when an endpoint object is gone and has no fallback", () => {
    // Inventing a line to the origin would show an edge the user never drew.
    const resolved = resolveConnector(
      connector({ source: { objectId: "missing" } }),
      indexObjects([box("b", 200, 0)]),
    );
    expect(resolved).toBeNull();
  });

  it("returns null when both objects are missing", () => {
    expect(resolveConnector(connector(), indexObjects([]))).toBeNull();
  });
});

describe("resolveConnector — routing", () => {
  const diagonal = [box("a", 0, 0), box("b", 200, 200)];

  it("draws a straight line for straight routing", () => {
    const resolved = resolveConnector(
      connector({ routing: "straight" }),
      indexObjects(diagonal),
    );
    expect(resolved!.d).toBe("M 100 100 L 200 200");
  });

  it("draws a balanced Z for orthogonal routing", () => {
    const resolved = resolveConnector(
      connector({ routing: "orthogonal" }),
      indexObjects(diagonal),
    );
    // Turns at the midpoint of the dominant axis, so the two halves stay equal
    // as either shape is dragged.
    expect(resolved!.d).toBe("M 100 100 L 150 100 L 150 200 L 200 200");
  });

  it("turns on the vertical axis first when vertical dominates", () => {
    const vertical = [box("a", 0, 0), box("b", 20, 300)];
    const resolved = resolveConnector(
      connector({ routing: "orthogonal" }),
      indexObjects(vertical),
    );
    // Asserted structurally rather than against literal coordinates: the exact
    // numbers fall out of perimeter clipping and are not the point. The point is
    // that the first segment runs vertically, so the turn follows the dominant
    // axis rather than always running horizontally first.
    const segments = resolved!.d.split(" L ");
    const start = segments[0]!.replace("M ", "").split(" ").map(Number);
    const first = segments[1]!.split(" ").map(Number);
    expect(first[0]).toBeCloseTo(start[0]!, 6);
    expect(first[1]).not.toBeCloseTo(start[1]!, 6);
  });

  it("draws a cubic curve for curved routing", () => {
    const resolved = resolveConnector(
      connector({ routing: "curved" }),
      indexObjects(diagonal),
    );
    expect(resolved!.d).toBe("M 100 100 C 150 100 150 200 200 200");
  });

  it("produces only finite coordinates for every routing on awkward geometry", () => {
    // Coincident objects: both centres are the same point, so the direction is
    // degenerate and a naive implementation yields NaN.
    const coincident = [box("a", 0, 0), box("b", 0, 0)];
    for (const routing of ["straight", "orthogonal", "curved"] as const) {
      const resolved = resolveConnector(
        connector({ routing }),
        indexObjects(coincident),
      );
      expect(resolved).not.toBeNull();
      expect(resolved!.d).not.toContain("NaN");
      expect(resolved!.d).not.toContain("Infinity");
      expect(Number.isFinite(resolved!.start.x)).toBe(true);
      expect(Number.isFinite(resolved!.end.y)).toBe(true);
    }
  });
});

describe("resolveConnector — following a moving object", () => {
  it("recomputes both anchors when the target is dragged", () => {
    const index = indexObjects([box("a", 0, 0)]);
    const before = resolveConnector(
      connector(),
      new Map([...index, ["b", box("b", 200, 0)]]),
    );
    const after = resolveConnector(
      connector(),
      new Map([...index, ["b", box("b", 200, 300)]]),
    );

    // Both ends are recomputed, and the source anchor moves too: it clips toward
    // B's new centre, so dragging B from A's right to below-right slides A's
    // attachment from the right edge to the bottom edge. An implementation that
    // pinned the source would leave the connector crossing through A.
    expect(before!.start).toEqual({ x: 100, y: 50 });
    expect(after!.start.x).toBeCloseTo(83.333, 2);
    expect(after!.start.y).toBeCloseTo(100, 6);
    expect(before!.end).toEqual({ x: 200, y: 50 });
    expect(after!.end.y).toBeCloseTo(300, 6);
    expect(after!.end.x).toBeCloseTo(216.667, 2);
    expect(after!.d).not.toBe(before!.d);
  });

  it("keeps every anchor on the perimeter of its own object", () => {
    const a = box("a", 0, 0);
    const b = box("b", 137, -260);
    const resolved = resolveConnector(connector(), indexObjects([a, b]));

    const onPerimeter = (
      point: { x: number; y: number },
      object: DiagramObject,
    ) => {
      const bounds = objectBounds(object);
      const touchesLeft = Math.abs(point.x - bounds.x) < 1e-6;
      const touchesRight = Math.abs(point.x - (bounds.x + bounds.width)) < 1e-6;
      const touchesTop = Math.abs(point.y - bounds.y) < 1e-6;
      const touchesBottom =
        Math.abs(point.y - (bounds.y + bounds.height)) < 1e-6;
      const insideX =
        point.x >= bounds.x - 1e-6 && point.x <= bounds.x + bounds.width + 1e-6;
      const insideY =
        point.y >= bounds.y - 1e-6 &&
        point.y <= bounds.y + bounds.height + 1e-6;
      return (
        (touchesLeft || touchesRight || touchesTop || touchesBottom) &&
        insideX &&
        insideY
      );
    };

    expect(onPerimeter(resolved!.start, a)).toBe(true);
    expect(onPerimeter(resolved!.end, b)).toBe(true);
  });
});

describe("resolveConnectors", () => {
  it("keys the result by connector id", () => {
    const resolved = resolveConnectors(
      [connector({ id: "c1" }), connector({ id: "c2" })],
      SIDE_BY_SIDE,
    );
    expect([...resolved.keys()].sort()).toEqual(["c1", "c2"]);
  });

  it("drops unresolvable connectors instead of throwing", () => {
    const resolved = resolveConnectors(
      [
        connector({ id: "good" }),
        connector({ id: "bad", source: { objectId: "missing" } }),
      ],
      SIDE_BY_SIDE,
    );
    expect(resolved.has("good")).toBe(true);
    expect(resolved.has("bad")).toBe(false);
    expect(resolved.size).toBe(1);
  });

  it("returns an empty map for no connectors", () => {
    expect(resolveConnectors([], SIDE_BY_SIDE).size).toBe(0);
  });
});

describe("indexObjects", () => {
  it("indexes by id so resolution does not rescan the object list", () => {
    const index = indexObjects(SIDE_BY_SIDE);
    expect(index.size).toBe(2);
    expect(index.get("a")?.id).toBe("a");
    expect(index.get("nope")).toBeUndefined();
  });

  it("lets a later duplicate id win, matching document order semantics", () => {
    const index = indexObjects([box("a", 0, 0), box("a", 500, 500)]);
    expect(index.size).toBe(1);
    expect(index.get("a")?.transform.x).toBe(500);
  });
});
