import { describe, expect, it } from "vitest";

import { createObject, identityTransform } from "../../src/renderer/src/editor/factories";
import { serializeObjectsToSvg } from "../../src/renderer/src/editor/canvas/svg-serialize";
import type { DiagramObject } from "../../src/renderer/src/document/model";

function rect(id: string, x = 0, y = 0): DiagramObject {
  return { ...createObject("rectangle", identityTransform(x, y, 100, 50)), id };
}

describe("serializeObjectsToSvg", () => {
  it("emits a standalone SVG root with the XML namespace (FR-EXP-12)", () => {
    const svg = serializeObjectsToSvg([rect("a")]);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("sets a viewBox that frames the content plus padding", () => {
    const svg = serializeObjectsToSvg([rect("a", 10, 20)], { padding: 5 });
    // Content spans x 10..110, y 20..70; padding 5 on every side.
    expect(svg).toContain('viewBox="5 15 110 60"');
    expect(svg).toContain('width="110"');
    expect(svg).toContain('height="60"');
  });

  it("preserves object ids as element ids (FR-EXP-11 rule 3)", () => {
    const svg = serializeObjectsToSvg([rect("service-1"), rect("db-2")]);
    expect(svg).toContain('id="service-1"');
    expect(svg).toContain('id="db-2"');
  });

  it("keeps document order as paint order (FR-EXP-11 rule 9)", () => {
    const svg = serializeObjectsToSvg([rect("first"), rect("second"), rect("third")]);
    const positions = ["first", "second", "third"].map((id) => svg.indexOf(`id="${id}"`));
    expect(positions.every((p) => p > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("omits the backdrop rect for a transparent export (FR-EXP-15)", () => {
    const transparent = serializeObjectsToSvg([rect("a")], { background: "transparent" });
    expect(transparent).not.toContain("<rect x=\"0\"");
    expect(transparent.match(/<rect/g)?.length).toBe(1);
  });

  it("composites an explicit background when asked (FR-EXP-16)", () => {
    const svg = serializeObjectsToSvg([rect("a")], { background: "white" });
    expect(svg).toContain('fill="white"');
  });

  it("resolves token colours to concrete hex so the file stands alone", () => {
    const svg = serializeObjectsToSvg([rect("a")]);
    // Export must not depend on the app's stylesheet being present.
    expect(svg).not.toContain("var(--");
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="#1b1b1b"');
  });

  it("keeps text as editable text rather than flattening it (FR-TEXT-07)", () => {
    const text = createObject("text", identityTransform(0, 0, 200, 40), {
      content: { value: "Auth Service" },
    });
    const svg = serializeObjectsToSvg([{ ...text, id: "label-1" }]);
    expect(svg).toContain("<text ");
    expect(svg).toContain("Auth Service");
    expect(svg).not.toContain("<path");
  });

  it("splits multiline labels into tspans (FR-TEXT-05)", () => {
    const text = createObject("text", identityTransform(0, 0, 200, 40), {
      content: { value: "line one\nline two" },
    });
    const svg = serializeObjectsToSvg([text]);
    expect(svg.match(/<tspan/g)?.length).toBe(2);
    expect(svg).toContain("line one");
    expect(svg).toContain("line two");
  });

  it("maps an ellipse tool to an SVG ellipse element", () => {
    const ellipse = createObject("ellipse", identityTransform(0, 0, 80, 40));
    const svg = serializeObjectsToSvg([ellipse]);
    expect(svg).toContain("<ellipse ");
    expect(svg).toContain('cx="40"');
    expect(svg).toContain('ry="20"');
  });

  it("escapes XML metacharacters in labels and ids", () => {
    const text = createObject("text", identityTransform(0, 0, 200, 40), {
      content: { value: `A < B & C > D "quoted" 'single'` },
    });
    const svg = serializeObjectsToSvg([{ ...text, id: "x&y" }]);
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&gt;");
    expect(svg).toContain("&quot;");
    expect(svg).toContain("&apos;");
    expect(svg).toContain('id="x&amp;y"');
    // No raw ampersand that is not part of an entity.
    expect(svg.replace(/&(amp|lt|gt|quot|apos);/g, "")).not.toContain("&");
  });

  it("applies rotation as an SVG transform about the object centre", () => {
    const rotated: DiagramObject = {
      ...rect("a"),
      transform: { ...identityTransform(0, 0, 100, 50), rotation: 45 },
    };
    const svg = serializeObjectsToSvg([rotated]);
    expect(svg).toContain('transform="rotate(45 50 25)"');
  });

  it("still produces a valid SVG document when nothing is drawn", () => {
    const svg = serializeObjectsToSvg([]);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("viewBox=");
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("honours explicit bounds over computed content bounds", () => {
    const svg = serializeObjectsToSvg([rect("a")], {
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      padding: 0,
    });
    expect(svg).toContain('viewBox="0 0 800 600"');
  });

  it("never emits a zero or negative viewport size", () => {
    const svg = serializeObjectsToSvg([], {
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      padding: 0,
    });
    expect(svg).toContain('width="1"');
    expect(svg).toContain('height="1"');
  });
});
