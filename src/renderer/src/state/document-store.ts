import { create } from "zustand";

import type {
  DiagramDocument,
  DiagramObject,
  DiagramStyle,
  DocumentMeta,
  TextContent,
  Transform,
  Viewport,
} from "../document/model";
import { createEmptyDocument } from "../document/empty-document";
import type { DocumentMutator, ExtractedObject } from "../editor/commands";

export interface DocumentState extends DocumentMutator {
  document: DiagramDocument;
  isDirty: boolean;
  activePageId: string;
  loadDocument(document: DiagramDocument): void;
  newDocument(): void;
  markClean(): void;
  setViewport(viewport: Viewport): void;
  setMeta(patch: Partial<DocumentMeta>): void;
}

/**
 * Array position is the authoritative paint order, because that is what an SVG
 * renderer consumes. `zIndex` is kept as a denormalised mirror of it so the
 * serialised document stays readable and z-order operations have somewhere to
 * write, but the two can never disagree.
 */
function reindex(objects: readonly DiagramObject[]): DiagramObject[] {
  return objects.map((object, index) =>
    object.zIndex === index ? object : { ...object, zIndex: index },
  );
}

/**
 * Created as a factory so tests get an isolated store; the exported singleton is
 * what the app renders against.
 */
export function createDocumentStore(
  initialDocument: DiagramDocument = createEmptyDocument(),
) {
  return create<DocumentState>()((set, get) => {
    const mutateObjects = (
      fn: (objects: readonly DiagramObject[]) => DiagramObject[],
    ): void => {
      const { document, activePageId } = get();
      set({
        isDirty: true,
        document: {
          ...document,
          pages: document.pages.map((page) =>
            page.id === activePageId
              ? { ...page, objects: reindex(fn(page.objects)) }
              : page,
          ),
        },
      });
    };

    const activeObjects = (): readonly DiagramObject[] => {
      const { document, activePageId } = get();
      return (
        document.pages.find((page) => page.id === activePageId)?.objects ?? []
      );
    };

    return {
      document: initialDocument,
      isDirty: false,
      activePageId: initialDocument.pages[0]?.id ?? "",

      loadDocument(document) {
        set({
          document,
          isDirty: false,
          activePageId: document.pages[0]?.id ?? "",
        });
      },

      newDocument() {
        const fresh = createEmptyDocument();
        set({
          document: fresh,
          isDirty: false,
          activePageId: fresh.pages[0]?.id ?? "",
        });
      },

      markClean() {
        set({ isDirty: false });
      },

      setViewport(viewport) {
        const { document, activePageId } = get();
        set({
          document: {
            ...document,
            pages: document.pages.map((page) =>
              page.id === activePageId ? { ...page, viewport } : page,
            ),
          },
        });
      },

      setMeta(patch) {
        const { document } = get();
        set({
          isDirty: true,
          document: { ...document, meta: { ...document.meta, ...patch } },
        });
      },

      insertObjects(objects) {
        if (objects.length === 0) return;
        mutateObjects((existing) => [...existing, ...objects]);
      },

      extractObjects(ids) {
        const wanted = new Set(ids);
        const extracted: ExtractedObject[] = [];
        // The updater records what it removed so the caller can undo it. `set`
        // is synchronous, so `extracted` is fully populated by the time
        // mutateObjects returns.
        mutateObjects((objects) => {
          const kept: DiagramObject[] = [];
          objects.forEach((object, index) => {
            if (wanted.has(object.id)) extracted.push({ object, index });
            else kept.push(object);
          });
          return kept;
        });
        return extracted;
      },

      restoreObjects(extracted) {
        if (extracted.length === 0) return;
        const ordered = [...extracted].sort((a, b) => a.index - b.index);
        mutateObjects((objects) => {
          const next = [...objects];
          for (const { object, index } of ordered) {
            next.splice(Math.min(index, next.length), 0, object);
          }
          return next;
        });
      },

      setTransforms(entries) {
        mutateObjects((objects) =>
          objects.map((object) => {
            const next = entries[object.id];
            return next ? { ...object, transform: next } : object;
          }),
        );
      },

      setStyles(entries) {
        mutateObjects((objects) =>
          objects.map((object) => {
            const next = entries[object.id];
            return next ? { ...object, style: next } : object;
          }),
        );
      },

      getTransforms(ids) {
        const wanted = new Set(ids);
        const result: Record<string, Transform> = {};
        for (const object of activeObjects()) {
          if (wanted.has(object.id)) result[object.id] = object.transform;
        }
        return result;
      },

      getStyles(ids) {
        const wanted = new Set(ids);
        const result: Record<string, DiagramStyle> = {};
        for (const object of activeObjects()) {
          if (wanted.has(object.id)) result[object.id] = object.style;
        }
        return result;
      },

      setContents(entries) {
        mutateObjects((objects) =>
          objects.map((object) =>
            // Key presence, not truthiness: an explicit `undefined` clears a
            // label, which is a different operation from leaving it alone.
            object.id in entries
              ? { ...object, content: entries[object.id] }
              : object,
          ),
        );
      },

      getContents(ids) {
        const wanted = new Set(ids);
        const result: Record<string, TextContent | undefined> = {};
        for (const object of activeObjects()) {
          if (wanted.has(object.id)) result[object.id] = object.content;
        }
        return result;
      },

      getObjectOrder() {
        return activeObjects().map((object) => object.id);
      },

      setObjectOrder(order) {
        if (order.length === 0) return;
        mutateObjects((objects) => {
          const remaining = new Map(
            objects.map((object) => [object.id, object]),
          );
          const sorted: DiagramObject[] = [];
          for (const id of order) {
            const object = remaining.get(id);
            if (!object) continue;
            sorted.push(object);
            remaining.delete(id);
          }
          // Anything the caller did not mention survives at the top, in its
          // original relative order: Map preserves insertion order, and dropping
          // these would silently delete objects from the document.
          for (const object of remaining.values()) sorted.push(object);
          return sorted;
        });
      },
    };
  });
}

export const useDocumentStore = createDocumentStore();

/** Non-React access for the canvas engine and command layer. */
export const documentStore = {
  getState: () => useDocumentStore.getState(),
  subscribe: (listener: (state: DocumentState) => void) =>
    useDocumentStore.subscribe((state) => listener(state)),
};

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
