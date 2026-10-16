import type { BoundingBox, DiagramObject } from "../../document/model";
import { objectsBounds } from "../geometry";
import { serializeObjectsToSvg, type SvgExportOptions } from "./svg-serialize";

/**
 * The seam required by NFR-MAINT-05: everything that would change if the canvas
 * engine were swapped lives behind this interface.
 *
 * It deliberately does not carry `mount`, `addObject`, `updateObject` or `render`
 * from TRD §9.1. That shape assumed an imperative canvas library (Fabric or
 * Konva) where the host must push objects into a scene graph. This engine renders
 * declaratively through React, so the document store *is* the scene graph and
 * those methods would be no-ops. Keeping them would be a fake abstraction that
 * misleads the next reader; what genuinely varies between engines is measurement
 * and export, so that is what is abstracted.
 */
export interface CanvasEngineAdapter {
  readonly id: string;
  /** Content bounds in world coordinates, or null when there is nothing drawn. */
  getContentBounds(objects: readonly DiagramObject[]): BoundingBox | null;
  /** Standalone SVG markup (FR-EXP-02, FR-EXP-11, FR-EXP-12). */
  exportSvg(objects: readonly DiagramObject[], options?: SvgExportOptions): string;
  /** Rasterised PNG/JPEG/WebP (FR-EXP-03, FR-EXP-04, FR-EXP-05, FR-EXP-14). */
  exportRaster(svg: string, options: RasterExportOptions): Promise<Blob>;
}

export type RasterFormat = "png" | "jpeg" | "webp";

export interface RasterExportOptions {
  format: RasterFormat;
  /** Unscaled size of the SVG viewBox, in world units. */
  width: number;
  height: number;
  /** FR-EXP-14: 1x-4x, or a DPI preset expressed as a multiplier. */
  scale?: number;
  /** FR-EXP-16: JPEG/WebP quality, 0-1. */
  quality?: number;
  /** JPEG has no alpha, so transparent areas composite over this (FR-EXP-15.3). */
  background?: string;
}

/** FR-EXP-15.3: guard against allocating a surface that exhausts memory. */
export const MAX_RASTER_DIMENSION = 16384;

const MIME_BY_FORMAT: Record<RasterFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(new Error("Could not rasterise the diagram: the SVG failed to load as an image."));
    image.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`The browser could not encode this canvas as ${mime}.`));
      },
      mime,
      quality,
    );
  });
}

export class SvgCanvasEngine implements CanvasEngineAdapter {
  readonly id = "svg";

  getContentBounds(objects: readonly DiagramObject[]): BoundingBox | null {
    return objectsBounds(objects);
  }

  exportSvg(objects: readonly DiagramObject[], options?: SvgExportOptions): string {
    return serializeObjectsToSvg(objects, options);
  }

  async exportRaster(svg: string, options: RasterExportOptions): Promise<Blob> {
    const scale = options.scale ?? 1;
    const width = Math.round(options.width * scale);
    const height = Math.round(options.height * scale);

    if (width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION) {
      // FR-EXP-18: an actionable message rather than a silent blank export.
      throw new Error(
        `Export size ${width}x${height} exceeds the ${MAX_RASTER_DIMENSION}px limit. Reduce the scale factor or export a smaller region.`,
      );
    }
    if (width < 1 || height < 1) {
      throw new Error("Export size must be at least 1 pixel in each dimension.");
    }

    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const image = await loadImage(url);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("A 2D canvas context is unavailable; raster export cannot proceed.");
      }

      // JPEG cannot carry alpha, so composite over the chosen background first.
      if (options.background) {
        context.fillStyle = options.background;
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(image, 0, 0, width, height);

      return await canvasToBlob(canvas, MIME_BY_FORMAT[options.format], options.quality);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export const canvasEngine: CanvasEngineAdapter = new SvgCanvasEngine();
