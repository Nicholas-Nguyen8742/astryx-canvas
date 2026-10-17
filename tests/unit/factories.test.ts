import { describe, expect, it } from "vitest";

import {
  PASTE_OFFSET,
  PREVIEW_ID,
  cloneObject,
  createObject,
  defaultSizeFor,
  identityTransform,
  normaliseDragTransform,
  previewObject,
  type ShapeTool,
} from "../../src/renderer/src/editor/factories";
import {
  lineEndpoints,
  shapeGeometry,
} from "../../src/renderer/src/editor/canvas/shape-attrs";
import { SHAPE_TOOLS } from "../../src/renderer/src/state/editor-store";
import type { DiagramObject } from "../../src/renderer/src/document/model";

describe("normaliseDragTransform", () => {
  it("keeps positive dimensions for a shape dragged right-to-left", () => {
    const transform = normaliseDragTransform(
      { x: 300, y: 200 },
      { x: 100, y: 50 },
      "rectangle",
    );
    expect(transform).toMatchObject({ x: 100, y: 50, width: 200, height: 150 });
  });

  it("falls back to the default size for a click without a drag", () => {
    const transform = normaliseDragTransform(
      { x: 40, y: 40 },
      { x: 41, y: 41 },
      "ellipse",
    );
    const fallback = defaultSizeFor("ellipse");
    expect(transform.width).toBe(fallback.width);
    expect(transform.height).toBe(fallback.height);
  });

  it("preserves line direction on the flip flags while keeping the box positive", () => {
    // Dragged from bottom-right to top-left: the line must still run that way.
    const transform = normaliseDragTransform(
      { x: 300, y: 200 },
      { x: 100, y: 50 },
      "line",
    );
    expect(transform.x).toBe(100);
    expect(transform.y).toBe(50);
    expect(transform.width).toBe(200);
    expect(transform.height).toBe(150);
    expect(transform.flipX).toBe(true);
    expect(transform.flipY).toBe(true);
  });

  it("leaves flip flags false for a line dragged left-to-right", () => {
    const transform = normaliseDragTransform(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      "arrow",
    );
    expect(transform.flipX).toBe(false);
    expect(transform.flipY).toBe(false);
    expect(transform.height).toBe(0);
  });

  it("gives a clicked line a usable default length instead of a zero-length dot", () => {
    const transform = normaliseDragTransform(
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      "line",
    );
    expect(transform.width).toBe(defaultSizeFor("line").width);
  });
});

describe("lineEndpoints", () => {
  it("runs top-left to bottom-right when unflipped", () => {
    expect(lineEndpoints(identityTransform(10, 20, 100, 50))).toEqual({
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 70,
    });
  });

  it("reverses horizontally under flipX", () => {
    const endpoints = lineEndpoints({
      ...identityTransform(10, 20, 100, 50),
      flipX: true,
    });
    expect(endpoints).toEqual({ x1: 110, y1: 20, x2: 10, y2: 70 });
  });

  it("reverses vertically under flipY", () => {
    const endpoints = lineEndpoints({
      ...identityTransform(10, 20, 100, 50),
      flipY: true,
    });
    expect(endpoints).toEqual({ x1: 10, y1: 70, x2: 110, y2: 20 });
  });

  it("round-trips a right-to-left drag back to the dragged direction", () => {
    const start = { x: 300, y: 200 };
    const end = { x: 100, y: 50 };
    const endpoints = lineEndpoints(
      normaliseDragTransform(start, end, "arrow"),
    );
    expect(endpoints.x1).toBe(start.x);
    expect(endpoints.y1).toBe(start.y);
    expect(endpoints.x2).toBe(end.x);
    expect(endpoints.y2).toBe(end.y);
  });
});

describe("createObject", () => {
  it("leaves lines and arrows stroke-only so they do not paint a solid box", () => {
    expect(
      createObject("line", identityTransform(0, 0, 100, 0)).style.fill,
    ).toBeUndefined();
    expect(
      createObject("arrow", identityTransform(0, 0, 100, 0)).style.fill,
    ).toBeUndefined();
  });

  it("still fills closed shapes", () => {
    expect(
      createObject("rectangle", identityTransform(0, 0, 100, 50)).style.fill,
    ).toBeDefined();
  });

  it("maps tools to the right document object types", () => {
    expect(createObject("arrow", identityTransform(0, 0, 10, 0)).type).toBe(
      "arrow",
    );
    expect(createObject("line", identityTransform(0, 0, 10, 0)).type).toBe(
      "line",
    );
    expect(
      createObject("roundedRectangle", identityTransform(0, 0, 10, 10)).type,
    ).toBe("roundedRectangle");
  });

  it("gives a rounded rectangle a corner radius and a text object a label", () => {
    expect(
      createObject("roundedRectangle", identityTransform(0, 0, 10, 10)).style
        .cornerRadius,
    ).toBeGreaterThan(0);
    expect(
      createObject("text", identityTransform(0, 0, 10, 10)).content?.value,
    ).toBe("Text");
  });

  it("issues a distinct id per object", () => {
    const a = createObject("rectangle", identityTransform(0, 0, 10, 10));
    const b = createObject("rectangle", identityTransform(0, 0, 10, 10));
    expect(a.id).not.toBe(b.id);
  });
});

describe("cloneObject", () => {
  const original: DiagramObject = createObject(
    "rectangle",
    identityTransform(10, 10, 100, 50),
    {
      content: { value: "Auth Service" },
    },
  );

  it("assigns a fresh id so the copy is not the same object", () => {
    const copy = cloneObject(original);
    expect(copy.id).not.toBe(original.id);
  });

  it("offsets the copy so it is not hidden exactly beneath the original", () => {
    const copy = cloneObject(original);
    expect(copy.transform.x).toBe(original.transform.x + PASTE_OFFSET.x);
    expect(copy.transform.y).toBe(original.transform.y + PASTE_OFFSET.y);
  });

  it("honours a custom offset", () => {
    const copy = cloneObject(original, { x: 0, y: 0 });
    expect(copy.transform.x).toBe(original.transform.x);
    expect(copy.transform.y).toBe(original.transform.y);
  });

  it("deep-copies style and content so editing one cannot change the other", () => {
    const copy = cloneObject(original);
    expect(copy.style).not.toBe(original.style);
    expect(copy.content).not.toBe(original.content);

    copy.style.strokeWidth = 99;
    if (copy.content) copy.content.value = "mutated";

    expect(original.style.strokeWidth).not.toBe(99);
    expect(original.content?.value).toBe("Auth Service");
  });

  it("preserves geometry, type and visibility", () => {
    const copy = cloneObject(original);
    expect(copy.type).toBe(original.type);
    expect(copy.visible).toBe(original.visible);
    expect(copy.locked).toBe(original.locked);
    expect(copy.transform.width).toBe(original.transform.width);
    expect(copy.transform.height).toBe(original.transform.height);
  });

  it("resets zIndex so the document store can reindex on insert", () => {
    expect(cloneObject({ ...original, zIndex: 7 }).zIndex).toBe(0);
  });
});

describe("new shape tools (FR-OBJ-01)", () => {
  it("maps circle, diamond and triangle to their document object types", () => {
    for (const tool of ["circle", "diamond", "triangle"] as const) {
      expect(createObject(tool, identityTransform(0, 0, 10, 10)).type).toBe(
        tool,
      );
    }
  });

  it("fills the closed shapes, unlike lines and arrows", () => {
    for (const tool of ["circle", "diamond", "triangle"] as const) {
      expect(
        createObject(tool, identityTransform(0, 0, 10, 10)).style.fill,
      ).toBeDefined();
    }
  });

  it("gives every tool a usable default size for a click without a drag", () => {
    for (const tool of SHAPE_TOOLS) {
      if (tool === "line" || tool === "arrow") continue;
      const size = defaultSizeFor(tool);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });

  it("defaults a circle to a square, so a bare click cannot yield an ellipse", () => {
    const size = defaultSizeFor("circle");
    expect(size.width).toBe(size.height);
  });

  it("keeps the store's tool list and the factory's tool type in step", () => {
    // If a tool is added to one and not the other, `createObject` would be
    // handed a value it cannot map and would silently produce an undefined type.
    const tools: readonly ShapeTool[] = SHAPE_TOOLS;
    expect(tools).toHaveLength(9);
    for (const tool of tools) {
      expect(createObject(tool, identityTransform(0, 0, 10, 10)).type).toBe(
        tool,
      );
    }
  });
});

describe("previewObject", () => {
  const tools: readonly ShapeTool[] = SHAPE_TOOLS;
  const transform = identityTransform(10, 20, 120, 80);

  /** Ids are `<prefix>_<counter>_<time>`, both parts base 36. */
  function counterOf(id: string): number {
    return parseInt(id.split("_")[1] ?? "", 36);
  }

  it("reuses one reserved id instead of minting an id per frame", () => {
    expect(previewObject("rectangle", transform).id).toBe(PREVIEW_ID);
    expect(previewObject("ellipse", transform).id).toBe(PREVIEW_ID);
  });

  it("does not advance the counter that real objects are numbered from", () => {
    const before = createObject("rectangle", transform).id;
    for (const tool of tools) previewObject(tool, transform);
    const after = createObject("rectangle", transform).id;
    expect(counterOf(after)).toBe(counterOf(before) + 1);
  });

  it("is locked, so a preview can never be selected or inline-edited", () => {
    expect(previewObject("rectangle", transform).locked).toBe(true);
  });

  it("carries no stroke colour, leaving the .canvas-preview rule the only owner", () => {
    // A CSS declaration beats an SVG presentation attribute, so a stroke here
    // would be dead code that silently loses — and would look authoritative.
    expect(previewObject("rectangle", transform).style.stroke).toBeUndefined();
  });

  it("draws the same SVG element as the committed shape, for every tool", () => {
    // The anti-drift guarantee behind routing the preview through shapeGeometry.
    // Were a tool to render one element while dragging and another once
    // committed, the user would see the shape change on release.
    for (const tool of tools) {
      const preview = shapeGeometry(previewObject(tool, transform), "dom");
      const committed = shapeGeometry(createObject(tool, transform), "dom");
      expect(preview.element).toBe(committed.element);
    }
  });

  it("gives a text preview the same placeholder label createObject does", () => {
    expect(previewObject("text", transform).content?.value).toBe("Text");
  });
});
