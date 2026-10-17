import { BrowserWindow } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PdfOrientation, PdfPageSize } from "../shared/ipc";

const POINTS_PER_INCH = 72;

export interface PdfRenderOptions {
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  marginPoints: number;
}

/**
 * Wraps exported SVG in the smallest possible print document.
 *
 * `width: 100%; height: auto` fits the drawing to the printable width and lets
 * the SVG's own viewBox carry the aspect ratio, which is the fit-to-page
 * behaviour FR-EXP-09 asks for. `@page { margin: 0 }` stops Chromium adding its
 * own margin on top of the one passed to printToPDF, so the margin is applied
 * exactly once.
 */
function printDocument(svg: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Export</title>
<style>
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; }
  svg { display: block; width: 100%; height: auto; }
</style>
</head>
<body>
${svg}
</body>
</html>
`;
}

/**
 * Renders SVG to a vector PDF through Chromium (FR-EXP-01, and the fallback path
 * TRD §15.4 sanctions).
 *
 * This is a genuine vector route rather than a rasterised one: Chromium draws the
 * SVG into the PDF as paths, so text stays text and the output stays sharp at any
 * zoom. That is why the jsPDF + svg2pdf dependency the TRD proposes is not needed
 * for acceptable fidelity — it would add two libraries to re-implement what the
 * renderer already does.
 *
 * Uses a throwaway hidden window rather than the app's own webContents, because
 * printing the main window would capture the toolbar, rails and status bar
 * instead of the diagram. JavaScript is disabled: the page is static markup.
 */
export async function renderSvgToPdf(svg: string, options: PdfRenderOptions): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "astryx-pdf-"));
  const htmlPath = join(directory, "print.html");

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });

  try {
    await writeFile(htmlPath, printDocument(svg), "utf8");
    await window.loadFile(htmlPath);

    const marginInches = Math.max(options.marginPoints, 0) / POINTS_PER_INCH;
    return await window.webContents.printToPDF({
      pageSize: options.pageSize,
      landscape: options.orientation === "landscape",
      printBackground: true,
      margins: {
        top: marginInches,
        bottom: marginInches,
        left: marginInches,
        right: marginInches,
      },
    });
  } finally {
    // destroy() rather than close(): close() is async and can be deferred by a
    // before-quit handler, which would leak a window per failed export.
    if (!window.isDestroyed()) window.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}
