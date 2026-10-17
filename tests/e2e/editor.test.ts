import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * End-to-end coverage for the editing journey (TRD §22.2).
 *
 * This is the layer that proves the canvas actually works when clicked. The unit
 * suite covers the pure logic underneath, but the pointer handlers in SvgCanvas
 * are only exercisable against a real Electron window with a real compositor.
 *
 * `playwright-core` ships no `expect`, so assertions poll through `waitFor`
 * rather than using Playwright's web-first matchers.
 */

let app: ElectronApplication;
let window: Page;
let profileDir: string;
const pageErrors: Error[] = [];
const consoleErrors: string[] = [];

const POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

/** NFR-PERF-01: the window must be usable within 3s of a cold start. */
const COLD_START_BUDGET_MS = 3_000;

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  description: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${description}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

interface ScreenPoint {
  x: number;
  y: number;
}

async function canvasBox(): Promise<
  ScreenPoint & { width: number; height: number }
> {
  const box = await window.locator(".canvas-host svg").boundingBox();
  if (!box) throw new Error("The canvas SVG reported no bounding box.");
  return box;
}

async function drag(from: ScreenPoint, to: ScreenPoint): Promise<void> {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  // Intermediate steps matter: a single jump would not exercise the pointermove
  // path that drives live dragging.
  await window.mouse.move(to.x, to.y, { steps: 10 });
  await window.mouse.up();
}

const objects = () => window.locator("svg [data-object-id]");

async function objectCount(): Promise<number> {
  return objects().count();
}

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function geometryOf(index = 0): Promise<Geometry> {
  return objects()
    .nth(index)
    .evaluate((element) => ({
      x: Number(element.getAttribute("x")),
      y: Number(element.getAttribute("y")),
      width: Number(element.getAttribute("width")),
      height: Number(element.getAttribute("height")),
    }));
}

async function drawRectangle(
  atX = 180,
  atY = 130,
  expectedCount = 1,
): Promise<void> {
  await window.getByRole("button", { name: "Rectangle", exact: true }).click();
  const box = await canvasBox();
  await drag(
    { x: box.x + atX, y: box.y + atY },
    { x: box.x + atX + 140, y: box.y + atY + 90 },
  );
  // Must wait for *this* shape, not merely for the canvas to be non-empty: a
  // `>= 1` condition passes instantly when an earlier shape already exists.
  await waitFor(
    async () => (await objectCount()) >= expectedCount,
    `${expectedCount} shape(s) on the canvas`,
  );
}

async function statusText(): Promise<string> {
  const text = await window.locator(".astryx-layout-footer").innerText();
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The transient result message lives in the content region, not the footer —
 * the footer only carries the persistent readouts (file, counts, zoom).
 */
async function statusMessage(): Promise<string> {
  const node = window.locator(".status-message");
  return (await node.count()) > 0
    ? (await node.first().innerText()).trim()
    : "";
}

async function resetCanvas(): Promise<void> {
  await window.keyboard.press("Control+a");
  await window.keyboard.press("Delete");
  await waitFor(
    async () => (await objectCount()) === 0,
    "the canvas to be cleared",
  );
}

/**
 * Cold-start duration, from the launch call to the canvas existing in the DOM.
 *
 * That span covers Electron process spawn, main-process init, window creation,
 * renderer bundle load and parse, and the React mount — the wait a user actually
 * experiences. It excludes OS-level executable load and asar unpacking, so a
 * packaged build will report somewhat worse than this.
 */
let coldStartMs = 0;

beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), "astryx-e2e-"));
  const startedAt = Date.now();
  app = await electron.launch({
    args: [join(process.cwd(), "out", "main", "index.js")],
    env: { ...process.env, ASTRYX_USER_DATA: profileDir },
  });
  window = await app.firstWindow();
  window.on("pageerror", (error) => pageErrors.push(error));
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await window.waitForSelector(".canvas-host", { timeout: 30_000 });
  coldStartMs = Date.now() - startedAt;
});

afterAll(async () => {
  await app?.close();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

describe("Astryx Architecture Canvas — editing journey", () => {
  beforeEach(async () => {
    await resetCanvas();
  });

  it("boots into a blank canvas with the desktop bridge attached", async () => {
    expect(await window.title()).toContain("Astryx");
    await expect(window.locator(".canvas-host").isVisible()).resolves.toBe(
      true,
    );
    expect(await objectCount()).toBe(0);

    // The bridge is injected by preload; without it the app renders a diagnostic
    // screen instead of the editor, so this also proves the hardened window loaded.
    const bridgePresent = await window.evaluate(
      () => typeof globalThis.astryxDesktop?.app?.getInfo === "function",
    );
    expect(bridgePresent).toBe(true);

    const info = await window.evaluate(() =>
      globalThis.astryxDesktop.app.getInfo(),
    );
    expect(info.ok).toBe(true);
  });

  it("reaches an interactive canvas inside the NFR-PERF-01 cold-start budget", () => {
    // Reported as well as asserted, because the number is the point. A bundler
    // warning about chunk size is not a performance measurement and should not
    // be optimised against as though it were; this is the user's actual wait.
    console.info(`[perf] cold start to canvas mounted: ${coldStartMs}ms`);
    expect(coldStartMs).toBeGreaterThan(0);
    expect(coldStartMs).toBeLessThan(COLD_START_BUDGET_MS);
  });

  it("draws a rectangle by dragging with the rectangle tool", async () => {
    await drawRectangle();

    expect(await objectCount()).toBe(1);
    const shape = await geometryOf();
    // Dragged 140 x 90 screen pixels at 100% zoom, so world units match.
    expect(shape.width).toBeCloseTo(140, 0);
    expect(shape.height).toBeCloseTo(90, 0);

    expect(await statusText()).toContain("1 objects");
  });

  it("returns to the select tool after drawing so the next drag does not draw again", async () => {
    await drawRectangle();
    const box = await canvasBox();
    // A drag over empty canvas with the select tool should marquee, not draw.
    await drag(
      { x: box.x + 40, y: box.y + 40 },
      { x: box.x + 90, y: box.y + 90 },
    );
    await window.waitForTimeout(200);
    expect(await objectCount()).toBe(1);
  });

  it("moves a selected shape by dragging it", async () => {
    await drawRectangle();
    const before = await geometryOf();

    const box = await canvasBox();
    await drag(
      { x: box.x + 250, y: box.y + 175 },
      { x: box.x + 330, y: box.y + 235 },
    );

    await waitFor(async () => {
      const now = await geometryOf();
      return now.x !== before.x || now.y !== before.y;
    }, "the shape to move");

    const after = await geometryOf();
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
    // A move must not silently resize the object.
    expect(after.width).toBeCloseTo(before.width, 0);
    expect(after.height).toBeCloseTo(before.height, 0);
  });

  it("undoes and redoes a move with the keyboard", async () => {
    await drawRectangle();
    const original = await geometryOf();

    const box = await canvasBox();
    await drag(
      { x: box.x + 250, y: box.y + 175 },
      { x: box.x + 330, y: box.y + 235 },
    );
    await waitFor(
      async () => (await geometryOf()).x !== original.x,
      "the shape to move",
    );
    const moved = await geometryOf();

    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await geometryOf()).x === original.x,
      "undo to restore the position",
    );
    expect(await geometryOf()).toMatchObject({ x: original.x, y: original.y });

    await window.keyboard.press("Control+Shift+z");
    await waitFor(
      async () => (await geometryOf()).x === moved.x,
      "redo to reapply the move",
    );
    expect(await geometryOf()).toMatchObject({ x: moved.x, y: moved.y });
  });

  it("deletes the selection and restores it on undo", async () => {
    await drawRectangle();
    expect(await objectCount()).toBe(1);

    await window.keyboard.press("Control+a");
    await window.keyboard.press("Delete");
    await waitFor(
      async () => (await objectCount()) === 0,
      "the shape to be deleted",
    );

    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await objectCount()) === 1,
      "undo to restore the shape",
    );
  });

  it("marquee-selects several shapes and reports the count", async () => {
    await drawRectangle(120, 100);
    await drawRectangle(340, 260, 2);
    expect(await objectCount()).toBe(2);

    const box = await canvasBox();
    await drag(
      { x: box.x + 60, y: box.y + 60 },
      { x: box.x + 560, y: box.y + 420 },
    );

    await waitFor(
      async () => (await statusText()).includes("2 selected"),
      "both shapes to be selected",
    );
    expect(await statusText()).toContain("2 selected");
  });

  it("resizes from a corner handle", async () => {
    await drawRectangle();
    const before = await geometryOf();

    // The south-east handle sits at the shape's bottom-right corner.
    const handle = window.locator('svg rect[data-handle="se"]');
    await waitFor(
      async () => (await handle.count()) === 1,
      "a resize handle to appear",
    );
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("Resize handle reported no bounding box.");

    await drag(
      {
        x: handleBox.x + handleBox.width / 2,
        y: handleBox.y + handleBox.height / 2,
      },
      { x: handleBox.x + 90, y: handleBox.y + 60 },
    );

    await waitFor(
      async () => (await geometryOf()).width !== before.width,
      "the shape to resize",
    );
    const after = await geometryOf();
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeGreaterThan(before.height);
    // The opposite corner stays anchored.
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  it("zooms from the toolbar and reflects it in the status bar", async () => {
    expect(await statusText()).toContain("100%");
    await window.getByRole("button", { name: "Zoom in" }).click();
    await waitFor(
      async () => !(await statusText()).includes("100%"),
      "the zoom readout to change",
    );
    expect(await statusText()).toContain("125%");

    await window.getByRole("button", { name: "Reset to 100%" }).click();
    await waitFor(
      async () => (await statusText()).includes("100%"),
      "zoom to reset",
    );
  });

  it("toggles the grid", async () => {
    const gridRect = window.locator('svg rect[fill="url(#astryx-grid)"]');
    expect(await gridRect.count()).toBe(1);

    await window.getByRole("button", { name: "Hide grid" }).click();
    await waitFor(
      async () => (await gridRect.count()) === 0,
      "the grid to be hidden",
    );

    await window.getByRole("button", { name: "Show grid" }).click();
    await waitFor(
      async () => (await gridRect.count()) === 1,
      "the grid to return",
    );
  });

  it("switches theme mode without reloading", async () => {
    // Asserted through the Button's own data-variant attribute, which the Astryx
    // theming contract documents, rather than guessing at a root attribute name.
    const dark = window.getByRole("button", { name: "Dark theme" });
    const light = window.getByRole("button", { name: "Light theme" });
    const urlBefore = window.url();

    await dark.click();
    await waitFor(
      async () => (await dark.getAttribute("data-variant")) === "secondary",
      "the dark theme control to become active",
    );
    expect(await light.getAttribute("data-variant")).toBe("ghost");

    await light.click();
    await waitFor(
      async () => (await light.getAttribute("data-variant")) === "secondary",
      "the light theme control to become active",
    );

    // FR-APP-13: switching theme must not require a reload.
    expect(window.url()).toBe(urlBefore);
  });

  it("draws an arrow that keeps its head and its dragged direction", async () => {
    await window.getByRole("button", { name: "Arrow", exact: true }).click();
    const box = await canvasBox();
    // Dragged right-to-left, so the head must end up on the left rather than
    // being normalised away by the positive bounding box.
    await drag(
      { x: box.x + 400, y: box.y + 200 },
      { x: box.x + 200, y: box.y + 200 },
    );
    await waitFor(
      async () => (await objectCount()) >= 1,
      "an arrow to appear on the canvas",
    );

    // A line renders as a <g data-object-id> holding a wide transparent hit
    // stroke plus the visible line, so select through the group.
    const visibleLine = window.locator("svg g[data-object-id] line").first();
    await waitFor(
      async () => (await visibleLine.count()) >= 1,
      "the arrow to render as a line",
    );

    expect(await visibleLine.getAttribute("marker-end")).toContain(
      "astryx-arrowhead",
    );
    expect(Number(await visibleLine.getAttribute("x1"))).toBeGreaterThan(
      Number(await visibleLine.getAttribute("x2")),
    );
    // Without the marker definition the head silently vanishes.
    expect(
      await window.locator("svg defs marker#astryx-arrowhead").count(),
    ).toBe(1);
  });

  /**
   * Playwright cannot drive a native OS save dialog, and leaving one open would
   * hang the suite. Substituting a fixed path lets the whole export chain run for
   * real: renderer serialisation, IPC transfer, and the main-process atomic
   * write. Only the OS modal itself is replaced.
   */
  async function stubSaveDialog(filePath: string): Promise<void> {
    await app.evaluate(({ dialog }, target) => {
      const bridge = dialog as unknown as {
        showSaveDialog: (...args: unknown[]) => Promise<unknown>;
      };
      bridge.showSaveDialog = async () => ({
        canceled: false,
        filePath: target,
      });
    }, filePath);
  }

  /**
   * Drives the export dialog for one format.
   *
   * The rail button and the dialog's confirm button carry the same label, so the
   * confirm click has to be scoped to the dialog or Playwright sees two matches
   * and fails on strict mode.
   */
  async function exportViaDialog(
    format: "SVG" | "PDF" | "PNG" | "JPEG",
  ): Promise<void> {
    await window
      .getByRole("button", { name: `Export ${format}`, exact: true })
      .first()
      .click();

    const dialog = window.getByRole("dialog");
    await waitFor(
      async () => (await dialog.count()) > 0,
      `the ${format} export dialog to open`,
    );
    await dialog
      .getByRole("button", { name: `Export ${format}`, exact: true })
      .click();
  }

  /** IHDR carries width and height big-endian at fixed offsets. */
  function pngSize(bytes: Buffer): { width: number; height: number } {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  it("exports SVG to disk through the main process", async () => {
    await drawRectangle();
    const target = join(profileDir, "e2e-export.svg");
    await stubSaveDialog(target);

    await exportViaDialog("SVG");
    await waitFor(() => existsSync(target), "the SVG export to reach the disk");

    const contents = readFileSync(target, "utf8");
    expect(contents.startsWith("<svg ")).toBe(true);
    expect(contents).toContain('xmlns="http://www.w3.org/2000/svg"');
    // Standalone means no dependence on the app's own stylesheet (FR-EXP-12).
    expect(contents).not.toContain("var(--");
    await waitFor(
      async () => (await statusMessage()).includes("Exported SVG"),
      "the status message to confirm the export",
    );
  });

  it("exports a vector PDF through Chromium print", async () => {
    await drawRectangle();
    const target = join(profileDir, "e2e-export.pdf");
    await stubSaveDialog(target);

    await exportViaDialog("PDF");
    // Printing spins up a hidden window, so this gets a longer leash.
    await waitFor(
      () => existsSync(target),
      "the PDF export to reach the disk",
      30_000,
    );

    const bytes = readFileSync(target);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  // FR-EXP-03/04, checked the way TRD §22.3 prescribes: magic bytes, then size.
  // These two are the only coverage the raster path has — it needs a real DOM for
  // Image and a 2D canvas, so it cannot run in the node unit environment.
  it("exports a PNG raster to disk", async () => {
    await drawRectangle();
    const target = join(profileDir, "e2e-export.png");
    await stubSaveDialog(target);

    await exportViaDialog("PNG");
    await waitFor(
      () => existsSync(target),
      "the PNG export to reach the disk",
      30_000,
    );

    const bytes = readFileSync(target);
    expect(Array.from(bytes.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(bytes.byteLength).toBeGreaterThan(100);

    // Proves the scale option is actually applied rather than ignored
    // (FR-EXP-14). The drawn rectangle is 140x90 world units; the exporter pads
    // by 24 on every side, and the dialog defaults to 2x, so the raster must be
    // (140 + 48) * 2 by (90 + 48) * 2.
    expect(pngSize(bytes)).toEqual({ width: 376, height: 276 });
  });

  it("exports a JPEG raster to disk", async () => {
    await drawRectangle();
    const target = join(profileDir, "e2e-export.jpg");
    await stubSaveDialog(target);

    await exportViaDialog("JPEG");
    await waitFor(
      () => existsSync(target),
      "the JPEG export to reach the disk",
      30_000,
    );

    const bytes = readFileSync(target);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
    expect(bytes.byteLength).toBeGreaterThan(100);
  });

  /** Draws a text object and returns a locator for its rendered SVG label. */
  async function drawText(): Promise<ReturnType<Page["locator"]>> {
    await window.getByRole("button", { name: "Text", exact: true }).click();
    const box = await canvasBox();
    await drag(
      { x: box.x + 200, y: box.y + 150 },
      { x: box.x + 420, y: box.y + 210 },
    );
    await waitFor(
      async () => (await objectCount()) >= 1,
      "a text object to appear",
    );
    return window.locator("svg text[data-object-id]").first();
  }

  async function openInlineEditor(): Promise<ReturnType<Page["locator"]>> {
    const label = window.locator("svg text[data-object-id]").first();
    const box = await label.boundingBox();
    if (!box) throw new Error("The text object reported no bounding box.");
    await window.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);

    const editor = window.locator(".canvas-host textarea");
    await waitFor(
      async () => (await editor.count()) === 1,
      "the inline editor to open",
    );
    return editor;
  }

  /** SVG has no innerText semantics that matter here; textContent works on any node. */
  async function labelText(): Promise<string> {
    return (
      (await window
        .locator("svg text[data-object-id]")
        .first()
        .textContent()) ?? ""
    ).trim();
  }

  it("edits a text label inline and undoes it as one step", async () => {
    const label = await drawText();
    // The factory seeds a placeholder label.
    expect(((await label.textContent()) ?? "").trim()).toBe("Text");

    const editor = await openInlineEditor();
    await editor.fill("Auth Service");

    // Blurring commits (FR-TEXT-02).
    await window
      .locator(".canvas-host svg")
      .click({ position: { x: 4, y: 4 } });
    await waitFor(
      async () => (await window.locator(".canvas-host textarea").count()) === 0,
      "the inline editor to close",
    );
    await waitFor(
      async () => (await labelText()).includes("Auth Service"),
      "the new label to render on the canvas",
    );

    // Coalescing: one undo returns to the original label, not one keystroke back.
    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await labelText()) === "Text",
      "undo to restore the label",
    );
  });

  it("cancels an inline edit on Escape without committing it", async () => {
    await drawText();
    const editor = await openInlineEditor();

    await editor.fill("Discarded");
    await editor.press("Escape");

    await waitFor(
      async () => (await window.locator(".canvas-host textarea").count()) === 0,
      "the inline editor to close",
    );
    // Cancelling unmounts the textarea, which fires blur; a missing guard here
    // would commit the very draft the user just rejected.
    expect(await labelText()).toBe("Text");
  });

  /**
   * Draws with any shape tool.
   *
   * `drawRectangle` above predates the extra shapes; this generalises the same
   * drag-then-wait rather than duplicating it once per tool.
   */
  async function drawShape(
    toolLabel: string,
    atX: number,
    atY: number,
    expectedCount: number,
  ): Promise<void> {
    await window.getByRole("button", { name: toolLabel, exact: true }).click();
    const box = await canvasBox();
    await drag(
      { x: box.x + atX, y: box.y + atY },
      { x: box.x + atX + 140, y: box.y + atY + 90 },
    );
    await waitFor(
      async () => (await objectCount()) >= expectedCount,
      `${expectedCount} shape(s) on the canvas`,
    );
  }

  async function objectIds(): Promise<string[]> {
    return objects().evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-object-id") ?? ""),
    );
  }

  /**
   * Parses an SVG `points` attribute into numeric pairs.
   *
   * A polygon carries no x/y/width/height attributes, so `geometryOf` cannot
   * measure one — the vertices *are* its geometry.
   */
  function verticesOf(points: string): [number, number][] {
    return points
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return [x as number, y as number];
      });
  }

  function extentOf(vertices: readonly [number, number][]) {
    const xs = vertices.map(([x]) => x);
    const ys = vertices.map(([, y]) => y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }

  /** Selects the shape drawn at (100,120) by clicking inside it. */
  async function selectFirstShape(): Promise<void> {
    const box = await canvasBox();
    await window.mouse.click(box.x + 130, box.y + 150);
  }

  it("draws a diamond as a polygon inscribed in the dragged box", async () => {
    await drawShape("Diamond", 100, 120, 1);

    const polygon = window.locator("svg polygon[data-object-id]");
    expect(await polygon.count()).toBe(1);

    const vertices = verticesOf((await polygon.getAttribute("points")) ?? "");
    expect(vertices).toHaveLength(4);

    // Measured from the vertices rather than asserted as absolute coordinates:
    // the viewport is not necessarily at the origin, and being inscribed is what
    // actually matters, not where the shape landed.
    const { minX, maxX, minY, maxY } = extentOf(vertices);
    // Dragged 140 x 90 screen pixels at 100% zoom.
    expect(maxX - minX).toBeCloseTo(140, 0);
    expect(maxY - minY).toBeCloseTo(90, 0);

    // One vertex per edge, at its midpoint. A polygon drawn inside its own box
    // would leave the selection outline and the export frame surrounding air.
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    expect(vertices).toContainEqual([midX, minY]);
    expect(vertices).toContainEqual([maxX, midY]);
    expect(vertices).toContainEqual([midX, maxY]);
    expect(vertices).toContainEqual([minX, midY]);
  });

  it("draws a triangle as a polygon with an apex and a full-width base", async () => {
    await drawShape("Triangle", 100, 120, 1);

    const vertices = verticesOf(
      (await window
        .locator("svg polygon[data-object-id]")
        .getAttribute("points")) ?? "",
    );
    expect(vertices).toHaveLength(3);

    const { minX, maxX, minY, maxY } = extentOf(vertices);
    expect(maxX - minX).toBeCloseTo(140, 0);
    expect(maxY - minY).toBeCloseTo(90, 0);
    expect(vertices).toContainEqual([(minX + maxX) / 2, minY]);
    expect(vertices).toContainEqual([maxX, maxY]);
    expect(vertices).toContainEqual([minX, maxY]);
  });

  it("keeps a circle drag square even when the gesture is not", async () => {
    await drawShape("Circle", 100, 120, 1);

    const circle = window.locator("svg ellipse[data-object-id]");
    expect(await circle.count()).toBe(1);
    const rx = Number(await circle.getAttribute("rx"));
    const ry = Number(await circle.getAttribute("ry"));

    // The longer axis wins, so a 140 x 90 gesture yields a 140-unit circle. An
    // ellipse here would mean the "circle" type quietly contradicts itself.
    expect(rx).toBeCloseTo(70, 0);
    expect(ry).toBeCloseTo(70, 0);
  });

  it("keeps a circle round when resized from a corner handle", async () => {
    await drawShape("Circle", 100, 120, 1);

    const circle = window.locator("svg ellipse[data-object-id]");
    await waitFor(
      async () => (await circle.count()) === 1,
      "the circle to render",
    );

    // A circle renders as an ellipse, so it carries cx/cy/rx/ry and none of the
    // x/y/width/height attributes `geometryOf` reads.
    const metrics = async () => ({
      cx: Number(await circle.getAttribute("cx")),
      rx: Number(await circle.getAttribute("rx")),
      ry: Number(await circle.getAttribute("ry")),
    });
    const before = await metrics();
    expect(before.rx).toBeCloseTo(before.ry, 6);

    const handle = window.locator('svg rect[data-handle="se"]');
    await waitFor(
      async () => (await handle.count()) === 1,
      "a resize handle to appear",
    );
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("Resize handle reported no bounding box.");

    // Measured from the handle centre, not its corner, so the delta is exactly
    // 90 by 20 world units at 100% zoom. Deliberately lopsided: without the
    // square constraint this produces rx 115 against ry 80 — an ellipse that
    // still claims to be a circle, and nothing downstream can detect it.
    const start = {
      x: handleBox.x + handleBox.width / 2,
      y: handleBox.y + handleBox.height / 2,
    };
    await drag(start, { x: start.x + 90, y: start.y + 20 });

    await waitFor(
      async () => (await metrics()).rx !== before.rx,
      "the circle to resize",
    );

    const after = await metrics();
    expect(after.rx).toBeGreaterThan(before.rx);
    expect(after.rx).toBeCloseTo(after.ry, 6);
    // The dominant axis drives both, so the diameter grows by 90 rather than by
    // 90 horizontally and 20 vertically.
    expect(after.rx * 2).toBeCloseTo(before.rx * 2 + 90, 0);
    // The opposite corner stays anchored, exactly as it does unconstrained.
    expect(after.cx - after.rx).toBeCloseTo(before.cx - before.rx, 0);
  });

  it("brings a selected shape to the front and undoes it as one step", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 280, 120, 2);
    const before = await objectIds();
    expect(before).toHaveLength(2);

    await selectFirstShape();

    // The shifted binding. This is the one that silently does nothing if it is
    // matched on event.key: with Shift held a bracket key reports "}".
    await window.keyboard.press("Control+Shift+]");
    await waitFor(
      async () => (await objectIds())[1] === before[0],
      "the selected shape to paint last in the stack",
    );

    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await objectIds()).join("|") === before.join("|"),
      "undo to restore the original stack order",
    );
  });

  it("steps a shape forward exactly one place with the unshifted binding", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 280, 120, 2);
    await drawShape("Rectangle", 100, 260, 3);
    const before = await objectIds();
    expect(before).toHaveLength(3);

    await selectFirstShape();
    await window.keyboard.press("Control+]");

    const expected = [before[1], before[0], before[2]].join("|");
    await waitFor(
      async () => (await objectIds()).join("|") === expected,
      "the bottom shape to step up one place without jumping to the top",
    );
  });

  it("records no history entry when a shape is already at the front", async () => {
    await drawShape("Rectangle", 100, 120, 1);

    await selectFirstShape();
    await window.keyboard.press("Control+Shift+]");
    await window.keyboard.press("Control+Shift+]");

    // One object is always frontmost, so both presses were no-ops. A single undo
    // must therefore reach the Create command and remove the shape; had a no-op
    // been recorded, undo would spend itself on that and leave the shape in
    // place — the visible symptom of holding a shortcut and losing history.
    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await objectCount()) === 0,
      "one undo to reach the create command",
    );
  });

  it("reorders from the rail button, not only from the keyboard", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 280, 120, 2);
    const before = await objectIds();

    await selectFirstShape();
    await window
      .getByRole("button", { name: "Bring to front", exact: true })
      .click();

    await waitFor(
      async () => (await objectIds())[1] === before[0],
      "the rail button to move the selected shape to the top",
    );
  });

  /** Connectors live in their own id space, so they need their own locator. */
  const connectorNodes = () => window.locator("svg [data-connector-id]");

  async function connectorCount(): Promise<number> {
    return connectorNodes().count();
  }

  /** Clicks the middle of a shape drawn by `drawShape` at (x, y). */
  async function clickShapeCentre(x: number, y: number): Promise<void> {
    const box = await canvasBox();
    await window.mouse.click(box.x + x + 70, box.y + y + 45);
  }

  /** Draws two shapes and wires them, returning once the connector exists. */
  async function wireTwoShapes(): Promise<void> {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 320, 120, 2);
    await window
      .getByRole("button", { name: "Connector", exact: true })
      .click();
    await clickShapeCentre(100, 120);
    await clickShapeCentre(320, 120);
    await waitFor(
      async () => (await connectorCount()) === 1,
      "the connector to be created",
    );
  }

  it("wires a connector between two shapes with two clicks", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 320, 120, 2);
    expect(await connectorCount()).toBe(0);

    await wireTwoShapes();

    // The path is resolved from the shapes, not stored, so it must carry real
    // move and line commands rather than an empty or degenerate route.
    const d = await connectorNodes()
      .first()
      .locator("path")
      .last()
      .getAttribute("d");
    expect(d).toContain("M ");
    expect(d).toContain("L ");

    // The gesture hands control back, matching the shape tools.
    await waitFor(
      async () =>
        (await window
          .getByRole("button", { name: "Select", exact: true })
          .getAttribute("data-variant")) === "primary",
      "the tool to return to select",
    );
  });

  it("removes a connector with its shape and restores both on one undo", async () => {
    await wireTwoShapes();

    await clickShapeCentre(100, 120);
    await window.keyboard.press("Delete");
    await waitFor(
      async () => (await connectorCount()) === 0 && (await objectCount()) === 1,
      "the shape and its connector to go together",
    );

    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await connectorCount()) === 1 && (await objectCount()) === 2,
      "one undo to restore the shape and its connector",
    );
  });

  it("deletes a selected connector on its own", async () => {
    await wireTwoShapes();

    // The visible path is the second of the pair; the first is the transparent
    // hit stroke. Clicking either lands on the group carrying the id.
    const box = await canvasBox();
    await window.mouse.click(box.x + 280, box.y + 165);
    await window.keyboard.press("Delete");

    await waitFor(
      async () => (await connectorCount()) === 0,
      "the connector to be deleted",
    );
    // The shapes are untouched: a connector delete must not cascade upwards.
    expect(await objectCount()).toBe(2);

    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await connectorCount()) === 1,
      "undo to restore the connector",
    );
  });

  it("abandons a half-drawn connector on Escape", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 320, 120, 2);

    await window
      .getByRole("button", { name: "Connector", exact: true })
      .click();
    await clickShapeCentre(100, 120);
    await window.keyboard.press("Escape");

    // The pending source is gone, so the next click starts a fresh wire from its
    // own shape rather than completing the abandoned one. Had Escape not cleared
    // it, this click would produce a connector from the first shape.
    await clickShapeCentre(320, 120);
    await window.waitForTimeout(200);
    expect(await connectorCount()).toBe(0);
  });

  /**
   * Clicks a cardinal port of a shape drawn by `drawShape` at (x, y), which is
   * always 140x90. Screen offsets equal world offsets at 100% zoom, whatever the
   * viewport origin happens to be.
   */
  async function clickPort(
    x: number,
    y: number,
    port: "n" | "e" | "s" | "w",
  ): Promise<void> {
    const offsets = {
      n: { x: x + 70, y },
      e: { x: x + 140, y: y + 45 },
      s: { x: x + 70, y: y + 90 },
      w: { x, y: y + 45 },
    } as const;
    const box = await canvasBox();
    const offset = offsets[port];
    await window.mouse.click(box.x + offset.x, box.y + offset.y);
  }

  /** The connector's own `d`, from the visible path rather than the hit stroke. */
  async function connectorPath(): Promise<string> {
    return (
      (await connectorNodes()
        .first()
        .locator("path")
        .last()
        .getAttribute("d")) ?? ""
    );
  }

  /** First coordinate pair of a path: the connector's source anchor. */
  async function sourceAnchor(): Promise<string> {
    return (
      (await connectorPath()).match(/^M ([\d.eE+-]+ [\d.eE+-]+)/)?.[1] ?? ""
    );
  }

  it("shows four snap targets on the hovered shape while wiring", async () => {
    await drawShape("Rectangle", 100, 120, 1);

    await window
      .getByRole("button", { name: "Connector", exact: true })
      .click();
    const box = await canvasBox();
    await window.mouse.move(box.x + 170, box.y + 165);

    await waitFor(
      async () =>
        (await window.locator("svg circle.canvas-port").count()) === 4,
      "four port handles to appear on the hovered shape",
    );
  });

  it("pins a connector to the port it was drawn from", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 320, 120, 2);

    await window
      .getByRole("button", { name: "Connector", exact: true })
      .click();
    // East port of the first shape to west port of the second.
    await clickPort(100, 120, "e");
    await clickPort(320, 120, "w");
    await waitFor(
      async () => (await connectorCount()) === 1,
      "the connector to be created",
    );

    const pathBefore = await connectorPath();
    const anchorBefore = await sourceAnchor();
    expect(anchorBefore).not.toBe("");

    // Move the far shape well below the first. With the two side by side a
    // perimeter clip and the east port resolve to the same point, so this is the
    // only arrangement that distinguishes them: a pinned anchor must not move,
    // while a perimeter anchor would slide to the source's bottom edge.
    const box = await canvasBox();
    await drag(
      { x: box.x + 390, y: box.y + 165 },
      { x: box.x + 390, y: box.y + 365 },
    );

    await waitFor(
      async () => (await connectorPath()) !== pathBefore,
      "the connector to follow the shape that moved",
    );

    // Asserted on the source anchor rather than absolute coordinates: grid
    // snapping and the viewport origin both shift the exact numbers, and neither
    // is what this test is about.
    expect(await sourceAnchor()).toBe(anchorBefore);
  });

  /** The label rendered inside a connector's group, or "" when it has none. */
  async function connectorLabel(): Promise<string> {
    const text = connectorNodes().first().locator("text");
    return (await text.count()) > 0
      ? ((await text.textContent()) ?? "").trim()
      : "";
  }

  it("edits a connector label inline and undoes it as one step", async () => {
    await wireTwoShapes();
    expect(await connectorLabel()).toBe("");

    // Midway along the line between the two shapes.
    const box = await canvasBox();
    await window.mouse.dblclick(box.x + 280, box.y + 165);

    const editor = window.locator(".canvas-host textarea");
    await waitFor(
      async () => (await editor.count()) === 1,
      "the connector label editor to open",
    );

    await editor.fill("HTTPS");
    // Blurring commits, exactly as it does for an object label: the two share one
    // overlay, including the guard that stops the blur fired by an Escape cancel
    // from committing the draft the user just rejected.
    await window
      .locator(".canvas-host svg")
      .click({ position: { x: 4, y: 4 } });
    await waitFor(
      async () => (await window.locator(".canvas-host textarea").count()) === 0,
      "the editor to close",
    );
    await waitFor(
      async () => (await connectorLabel()) === "HTTPS",
      "the label to render on the canvas",
    );

    // One undo removes the whole edit rather than one keystroke of it.
    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await connectorLabel()) === "",
      "undo to remove the label",
    );
    // Losing its label must not cost the connector its existence.
    expect(await connectorCount()).toBe(1);
  });

  it("re-attaches a connector end by dragging it onto another shape", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 320, 120, 2);
    // A third shape, drawn before wiring so that selecting the connector is the
    // last thing that happens and its endpoint handles are still on screen.
    await drawShape("Rectangle", 320, 300, 3);

    await window
      .getByRole("button", { name: "Connector", exact: true })
      .click();
    await clickShapeCentre(100, 120);
    await clickShapeCentre(320, 120);
    await waitFor(
      async () => (await connectorCount()) === 1,
      "the connector to be created",
    );

    const box = await canvasBox();
    // Selecting the connector is what makes its ends draggable, and is also the
    // only visible sign that it is selected at all.
    await window.mouse.click(box.x + 280, box.y + 165);
    const handles = window.locator("svg circle.canvas-endpoint-handle");
    await waitFor(
      async () => (await handles.count()) === 2,
      "both endpoint handles to appear",
    );

    const pathBefore = await connectorPath();

    // The second handle is the target end. Drag it onto the third shape.
    const target = handles.nth(1);
    const targetBox = await target.boundingBox();
    if (!targetBox)
      throw new Error("Endpoint handle reported no bounding box.");
    await drag(
      {
        x: targetBox.x + targetBox.width / 2,
        y: targetBox.y + targetBox.height / 2,
      },
      { x: box.x + 390, y: box.y + 345 },
    );

    await waitFor(
      async () => (await connectorPath()) !== pathBefore,
      "the connector to be re-attached",
    );
    // Rewiring must not have duplicated or dropped the edge.
    expect(await connectorCount()).toBe(1);

    /** Start and end y of a straight route's "M x y L x y". */
    const endsOf = (d: string) => {
      const numbers = d.match(/-?[\d.]+/g)?.map(Number) ?? [];
      return { startY: numbers[1]!, endY: numbers[numbers.length - 1]! };
    };

    // Direction of travel rather than absolute coordinates, which grid snapping
    // and the viewport origin both shift. The two shapes start level, so the ends
    // share a y. A re-attachment that really landed on the third shape, drawn
    // below them, must pull the target end underneath the source; re-attaching to
    // the shape it already touched would leave them level and fail here.
    expect(endsOf(pathBefore).endY).toBeCloseTo(endsOf(pathBefore).startY, 6);
    const pathAfter = await connectorPath();
    expect(endsOf(pathAfter).endY).toBeGreaterThan(endsOf(pathAfter).startY);

    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await connectorPath()) === pathBefore,
      "undo to put the end back where it started",
    );
  });

  it("cancels a rewire dropped on empty canvas instead of detaching the end", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    await drawShape("Rectangle", 320, 120, 2);
    await window
      .getByRole("button", { name: "Connector", exact: true })
      .click();
    await clickShapeCentre(100, 120);
    await clickShapeCentre(320, 120);
    await waitFor(
      async () => (await connectorCount()) === 1,
      "the connector to be created",
    );

    const box = await canvasBox();
    await window.mouse.click(box.x + 280, box.y + 165);
    const handles = window.locator("svg circle.canvas-endpoint-handle");
    await waitFor(
      async () => (await handles.count()) === 2,
      "both endpoint handles to appear",
    );
    const pathBefore = await connectorPath();

    const target = handles.nth(1);
    const targetBox = await target.boundingBox();
    if (!targetBox)
      throw new Error("Endpoint handle reported no bounding box.");
    // Well clear of every shape, so there is nothing to attach to.
    await drag(
      {
        x: targetBox.x + targetBox.width / 2,
        y: targetBox.y + targetBox.height / 2,
      },
      { x: box.x + 280, y: box.y + 470 },
    );

    await window.waitForTimeout(200);
    // The end snaps back rather than being left floating: a free endpoint is
    // representable in the format but nothing else in the UI produces or marks
    // one, so an accidental drop should not silently create it.
    expect(await connectorPath()).toBe(pathBefore);
    // And nothing was recorded, so the next undo still belongs to an earlier edit.
    expect(await connectorCount()).toBe(1);
  });

  it("changes a connector's routing from the inspector and undoes it", async () => {
    await drawShape("Rectangle", 100, 120, 1);
    // Drawn below and to the right rather than level with the first, so the three
    // routings produce genuinely different paths. Two level shapes give a
    // straight line and an orthogonal Z the same two endpoints, and only the
    // number of segments would differ.
    await drawShape("Rectangle", 320, 300, 2);

    const routing = window.getByRole("combobox", { name: "Routing" });
    // Nothing selected, so the inspector has no connector controls to offer.
    expect(await routing.count()).toBe(0);

    await window
      .getByRole("button", { name: "Connector", exact: true })
      .click();
    await clickShapeCentre(100, 120);
    await clickShapeCentre(320, 300);
    await waitFor(
      async () => (await connectorCount()) === 1,
      "the connector to be created",
    );

    // Selecting the connector is what gives the inspector something to edit.
    // Midway along the line between the two shapes.
    const box = await canvasBox();
    await window.mouse.click(box.x + 280, box.y + 255);
    await waitFor(
      async () => (await routing.count()) === 1,
      "the routing control to appear in the inspector",
    );

    const straight = await connectorPath();
    expect(straight).not.toContain("C ");

    // Driven through the documented component class rather than a guessed ARIA
    // role: the theming table lists astryx-selector-option-row as the option
    // row's class, so that is a contract rather than an implementation detail.
    await routing.click();
    await window
      .locator(".astryx-selector-option-row", { hasText: "Curved" })
      .click();

    await waitFor(
      async () => (await connectorPath()).includes("C "),
      "the connector to redraw as a curve",
    );

    // One undo returns to the straight route and nothing else changes: a routing
    // control owns one property, so it must not disturb the arrowheads.
    await window.keyboard.press("Control+z");
    await waitFor(
      async () => (await connectorPath()) === straight,
      "undo to restore the straight route",
    );
  });

  // Runs last: a failure here means one of the journeys above threw inside React.
  it("produces no renderer errors across the whole journey", () => {
    expect(pageErrors.map((error) => error.message)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
