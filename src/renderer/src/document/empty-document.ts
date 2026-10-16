import { APP_ID, SCHEMA_VERSION, type DiagramDocument } from "./model";

export const UNTITLED_DOCUMENT_TITLE = "Untitled Diagram";

/**
 * The blank canvas a new document starts from (FR-CANVAS-01, FR-APP-05): one
 * empty page, no objects, no connectors, and the grid on so the surface reads as
 * a workspace rather than a void.
 */
export function createEmptyDocument(title: string = UNTITLED_DOCUMENT_TITLE): DiagramDocument {
  const now = new Date().toISOString();

  return {
    schemaVersion: SCHEMA_VERSION,
    appId: APP_ID,
    documentId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    meta: { title },
    pages: [
      {
        id: crypto.randomUUID(),
        name: "Page 1",
        viewport: { x: 0, y: 0, zoom: 1 },
        objects: [],
        connectors: [],
      },
    ],
    assets: [],
    settings: {
      defaultGrid: { enabled: true, size: 10, type: "dot" },
      defaultBackground: { hex: "#ffffff" },
      snapping: { enabled: true, gridSize: 10, objectTolerance: 6, smartGuides: true },
      connectorDefaults: {
        stroke: { hex: "#333333" },
        strokeWidth: 2,
        opacity: 1,
        endArrow: "triangle",
      },
      textDefaults: { fontSize: 14, textAlign: "center" },
    },
  };
}

export function serializeDocument(document: DiagramDocument): string {
  return JSON.stringify(
    { ...document, updatedAt: new Date().toISOString() },
    null,
    2,
  );
}
