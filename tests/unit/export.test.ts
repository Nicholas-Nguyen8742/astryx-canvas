import { describe, expect, it } from "vitest";

import { ExportError, exportDiagram } from "../../src/renderer/src/export";
import { createObject, identityTransform } from "../../src/renderer/src/editor/factories";
import type {
  DesktopApi,
  ExportFormat,
  PdfPrintRequest,
  SaveBlobRequest,
} from "../../src/shared/ipc";
import type { DiagramObject } from "../../src/renderer/src/document/model";

/**
 * Covers the export orchestration with a fake bridge.
 *
 * The SVG and PDF paths are fully exercisable here because both are pure in the
 * renderer: SVG is string generation and PDF is delegated to the main process.
 * The PNG and JPEG paths are *not* covered — `exportRaster` needs a real DOM
 * (Image plus a 2D canvas), which a node environment does not provide.
 */

function shape(id: string, x = 0, y = 0): DiagramObject {
  return { ...createObject("rectangle", identityTransform(x, y, 100, 50)), id };
}

const OBJECTS = [shape("a", 0, 0), shape("b", 200, 150)];

interface FakeDesktop {
  desktop: DesktopApi;
  saves: SaveBlobRequest[];
  pdfRequests: PdfPrintRequest[];
}

function makeDesktop(options: { canceled?: boolean; saveError?: string } = {}): FakeDesktop {
  const saves: SaveBlobRequest[] = [];
  const pdfRequests: PdfPrintRequest[] = [];

  const extensionFor: Record<ExportFormat, string> = {
    svg: "svg",
    png: "png",
    jpeg: "jpg",
    pdf: "pdf",
  };

  const desktop = {
    export: {
      saveBlob: async (request: SaveBlobRequest) => {
        saves.push(request);
        if (options.saveError) {
          return { ok: false, error: { code: "io", message: options.saveError } } as const;
        }
        if (options.canceled) {
          return { ok: true, value: { canceled: true, filePath: null } } as const;
        }
        return {
          ok: true,
          value: {
            canceled: false,
            filePath: `/tmp/${request.suggestedName}.${extensionFor[request.format]}`,
          },
        } as const;
      },
    },
    pdf: {
      printToPdf: async (request: PdfPrintRequest) => {
        pdfRequests.push(request);
        // "%PDF" — enough to assert the bytes reached the save unchanged.
        return { ok: true, value: new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer } as const;
      },
    },
  } as unknown as DesktopApi;

  return { desktop, saves, pdfRequests };
}

function decode(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

describe("exportDiagram — SVG", () => {
  it("writes standalone SVG markup through the save bridge", async () => {
    const { desktop, saves } = makeDesktop();
    const outcome = await exportDiagram(desktop, OBJECTS, [], "Network", { format: "svg" });

    expect(outcome.canceled).toBe(false);
    expect(outcome.format).toBe("svg");
    expect(outcome.bytes).toBeGreaterThan(0);
    expect(saves).toHaveLength(1);
    expect(saves[0]?.format).toBe("svg");
    expect(saves[0]?.suggestedName).toBe("Network");

    const svg = decode(saves[0]!.data as ArrayBuffer);
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // Both objects must survive into the file (FR-EXP-11).
    expect(svg).toContain('id="a"');
    expect(svg).toContain('id="b"');
  });

  it("resolves token colours to hex so the file stands alone (FR-EXP-12)", async () => {
    const { desktop, saves } = makeDesktop();
    await exportDiagram(desktop, OBJECTS, [], "Network", { format: "svg" });
    expect(decode(saves[0]!.data as ArrayBuffer)).not.toContain("var(--");
  });

  it("exports only the selection when scope is selection (FR-EXP-06)", async () => {
    const { desktop, saves } = makeDesktop();
    await exportDiagram(desktop, OBJECTS, ["b"], "Network", {
      format: "svg",
      scope: "selection",
    });

    const svg = decode(saves[0]!.data as ArrayBuffer);
    expect(svg).toContain('id="b"');
    expect(svg).not.toContain('id="a"');
  });

  it("falls back to the whole document when a selection scope is empty", async () => {
    const { desktop, saves } = makeDesktop();
    await exportDiagram(desktop, OBJECTS, [], "Network", {
      format: "svg",
      scope: "selection",
    });
    const svg = decode(saves[0]!.data as ArrayBuffer);
    expect(svg).toContain('id="a"');
    expect(svg).toContain('id="b"');
  });
});

describe("exportDiagram — PDF", () => {
  it("routes the generated SVG through the main process printer", async () => {
    const { desktop, pdfRequests, saves } = makeDesktop();
    const outcome = await exportDiagram(desktop, OBJECTS, [], "Network", { format: "pdf" });

    expect(pdfRequests).toHaveLength(1);
    expect(pdfRequests[0]?.svg.startsWith("<svg ")).toBe(true);
    // Documented defaults, so a bare Export PDF still produces a sane page.
    expect(pdfRequests[0]?.pageSize).toBe("A4");
    expect(pdfRequests[0]?.orientation).toBe("landscape");

    expect(outcome.format).toBe("pdf");
    expect(saves[0]?.format).toBe("pdf");
    // The bytes main returned must reach the file unchanged.
    expect(Array.from(new Uint8Array(saves[0]!.data as ArrayBuffer))).toEqual([
      0x25, 0x50, 0x44, 0x46,
    ]);
  });

  it("passes page size, orientation and margin straight through", async () => {
    const { desktop, pdfRequests } = makeDesktop();
    await exportDiagram(desktop, OBJECTS, [], "Network", {
      format: "pdf",
      pageSize: "Letter",
      orientation: "portrait",
      marginPoints: 36,
    });
    expect(pdfRequests[0]).toMatchObject({
      pageSize: "Letter",
      orientation: "portrait",
      marginPoints: 36,
    });
  });
});

describe("exportDiagram — failure paths", () => {
  it("refuses to export an empty canvas with an actionable message", async () => {
    const { desktop } = makeDesktop();
    await expect(exportDiagram(desktop, [], [], "Empty", { format: "svg" })).rejects.toThrow(
      ExportError,
    );
    await expect(exportDiagram(desktop, [], [], "Empty", { format: "svg" })).rejects.toThrow(
      /nothing to export/i,
    );
  });

  it("ignores hidden objects and reports emptiness when only those exist", async () => {
    const { desktop } = makeDesktop();
    const hidden = { ...shape("a"), visible: false };
    await expect(
      exportDiagram(desktop, [hidden], [], "Hidden", { format: "svg" }),
    ).rejects.toThrow(ExportError);
  });

  it("reports a cancelled save as cancelled rather than as a failure", async () => {
    const { desktop, saves } = makeDesktop({ canceled: true });
    const outcome = await exportDiagram(desktop, OBJECTS, [], "Network", { format: "svg" });
    expect(outcome.canceled).toBe(true);
    expect(outcome.filePath).toBeNull();
    expect(saves).toHaveLength(1);
  });

  it("surfaces a bridge write error as an ExportError (FR-EXP-18)", async () => {
    const { desktop } = makeDesktop({ saveError: "Disk full" });
    await expect(
      exportDiagram(desktop, OBJECTS, [], "Network", { format: "svg" }),
    ).rejects.toThrow(/Disk full/);
  });

  it("uses a fallback title so the suggested filename is never empty", async () => {
    const { desktop, saves } = makeDesktop();
    await exportDiagram(desktop, OBJECTS, [], "", { format: "svg" });
    expect(saves[0]?.suggestedName).toBe("Untitled Diagram");
  });
});
