import { mkdtempSync, rmSync } from "node:fs";
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

async function resetCanvas(): Promise<void> {
  await window.keyboard.press("Control+a");
  await window.keyboard.press("Delete");
  await waitFor(
    async () => (await objectCount()) === 0,
    "the canvas to be cleared",
  );
}

beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), "astryx-e2e-"));
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

  // Runs last: a failure here means one of the journeys above threw inside React.
  it("produces no renderer errors across the whole journey", () => {
    expect(pageErrors.map((error) => error.message)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
