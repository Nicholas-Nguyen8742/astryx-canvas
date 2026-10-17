import type {
  DesktopApi,
  ExportFormat,
  PdfOrientation,
  PdfPageSize,
} from "../../../shared/ipc";
import type { DiagramObject } from "../document/model";
import { UNTITLED_DOCUMENT_TITLE } from "../document/empty-document";
import { expandBounds } from "../editor/geometry";
import { canvasEngine } from "../editor/canvas/adapter";

/**
 * Export orchestration (TRD §15.5).
 *
 * The renderer generates bytes; the main process owns the save dialog and the
 * write. Nothing here touches the filesystem directly (NFR-SEC-05), and every
 * failure path produces a message a user can act on rather than a stack trace
 * (FR-EXP-18, NFR-USE-04).
 */

/** Margin the exported artwork keeps from the edge of its bounds. */
const EXPORT_PADDING = 24;

/** JPEG has no alpha channel, so transparency has to composite onto something. */
const JPEG_BACKGROUND = "#ffffff";

export type ExportScope = "document" | "selection";

export interface ExportRequest {
  format: ExportFormat;
  scope?: ExportScope;
  /** FR-EXP-14: raster multiplier. 1x-4x, or a DPI preset expressed as one. */
  scale?: number;
  /** FR-EXP-16: JPEG quality, 0-1. */
  quality?: number;
  /** "transparent" keeps alpha where the format supports it (FR-EXP-15). */
  background?: "transparent" | string;
  pageSize?: PdfPageSize;
  orientation?: PdfOrientation;
  marginPoints?: number;
}

export interface ExportOutcome {
  canceled: boolean;
  filePath: string | null;
  format: ExportFormat;
  bytes: number;
}

export class ExportError extends Error {}

function requireObjects(
  objects: readonly DiagramObject[],
  scope: ExportScope,
): DiagramObject[] {
  const exportable = objects.filter((object) => object.visible);
  if (exportable.length === 0) {
    throw new ExportError(
      scope === "selection"
        ? "Nothing is selected to export. Select one or more objects, or export the whole document."
        : "The canvas is empty, so there is nothing to export.",
    );
  }
  return exportable;
}

/**
 * Runs one export end to end and returns where it landed.
 *
 * SVG is the pivot format: raster goes SVG -> image -> canvas, and PDF goes
 * SVG -> Chromium print. Generating the markup once and branching on it is what
 * keeps all four formats visually identical to the canvas, because they share a
 * single serialisation path rather than four renderers.
 */
export async function exportDiagram(
  desktop: DesktopApi,
  allObjects: readonly DiagramObject[],
  selectedIds: readonly string[],
  documentTitle: string,
  request: ExportRequest,
): Promise<ExportOutcome> {
  const scope = request.scope ?? "document";
  const scoped =
    scope === "selection" && selectedIds.length > 0
      ? allObjects.filter((object) => selectedIds.includes(object.id))
      : allObjects;

  const objects = requireObjects(scoped, scope);

  const bounds = canvasEngine.getContentBounds(objects);
  if (!bounds) {
    throw new ExportError(
      "Could not measure the drawing, so there is nothing to export.",
    );
  }

  const background =
    request.format === "jpeg"
      ? request.background === "transparent"
        ? JPEG_BACKGROUND
        : (request.background ?? JPEG_BACKGROUND)
      : (request.background ?? "transparent");

  const svg = canvasEngine.exportSvg(objects, {
    background,
    padding: EXPORT_PADDING,
    bounds: expandBounds(bounds, EXPORT_PADDING),
  });

  let data: ArrayBuffer;
  switch (request.format) {
    case "svg":
      data = new TextEncoder().encode(svg).buffer as ArrayBuffer;
      break;

    case "pdf": {
      const result = await desktop.pdf.printToPdf({
        svg,
        pageSize: request.pageSize ?? "A4",
        orientation: request.orientation ?? "landscape",
        marginPoints: request.marginPoints ?? 0,
      });
      if (!result.ok) throw new ExportError(result.error.message);
      data = result.value;
      break;
    }

    case "png":
    case "jpeg": {
      const padded = expandBounds(bounds, EXPORT_PADDING);
      const blob = await canvasEngine.exportRaster(svg, {
        format: request.format,
        width: Math.max(Math.round(padded.width), 1),
        height: Math.max(Math.round(padded.height), 1),
        scale: request.scale ?? 2,
        quality:
          request.format === "jpeg" ? (request.quality ?? 0.92) : undefined,
        background: background === "transparent" ? undefined : background,
      });
      data = await blob.arrayBuffer();
      break;
    }
  }

  const saved = await desktop.export.saveBlob({
    // Owned here rather than at each call site: this module builds the save
    // request, so it is the one place that knows a blank title would otherwise
    // reach the dialog as an empty default filename.
    suggestedName: documentTitle.trim() || UNTITLED_DOCUMENT_TITLE,
    format: request.format,
    data,
  });
  if (!saved.ok) throw new ExportError(saved.error.message);
  if (saved.value.canceled || saved.value.filePath === null) {
    return { canceled: true, filePath: null, format: request.format, bytes: 0 };
  }

  return {
    canceled: false,
    filePath: saved.value.filePath,
    format: request.format,
    bytes: data.byteLength,
  };
}
