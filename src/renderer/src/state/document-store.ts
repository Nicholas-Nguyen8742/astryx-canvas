import { create } from "zustand";

import type {
  Connector,
  DiagramDocument,
  DiagramObject,
  DiagramStyle,
  DocumentMeta,
  Page,
  TextContent,
  Transform,
  Viewport,
} from "../document/model";
import { createEmptyDocument } from "../document/empty-document";
import type {
  DocumentMutator,
  ExtractedConnector,
  ExtractedObject,
} from "../editor/commands";

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
 *
 * Generic over anything carrying a `zIndex`, so connectors mirror their own
 * array by exactly the same rule as objects.
 */
function reindex<T extends { zIndex: number }>(items: readonly T[]): T[] {
  return items.map((item, index) =>
    item.zIndex === index ? item : { ...item, zIndex: index },
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
    /**
     * The one path that writes to the active page. Objects and connectors share
     * it so both dirty the document, both target only the active page, and both
     * re-stamp `zIndex` from array position by the same rule.
     */
    const mutatePage = (fn: (page: Page) => Page): void => {
      const { document, activePageId } = get();
      set({
        isDirty: true,
        document: {
          ...document,
          pages: document.pages.map((page) =>
            page.id === activePageId ? fn(page) : page,
          ),
        },
      });
    };

    const mutateObjects = (
      fn: (objects: readonly DiagramObject[]) => DiagramObject[],
    ): void =>
      mutatePage((page) => ({ ...page, objects: reindex(fn(page.objects)) }));

    const mutateConnectors = (
      fn: (connectors: readonly Connector[]) => Connector[],
    ): void =>
      mutatePage((page) => ({
        ...page,
        connectors: reindex(fn(page.connectors)),
      }));

    const activeObjects = (): readonly DiagramObject[] => {
      const { document, activePageId } = get();
      return (
        document.pages.find((page) => page.id === activePageId)?.objects ?? []
      );
    };

    const activeConnectors = (): readonly Connector[] => {
      const { document, activePageId } = get();
      return (
        document.pages.find((page) => page.id === activePageId)?.connectors ??
        []
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

      getConnectors() {
        // Copied, so a caller sorting or splicing the result cannot reorder the
        // store's own array behind its back.
        return [...activeConnectors()];
      },

      insertConnectors(connectors) {
        if (connectors.length === 0) return;
        mutateConnectors((existing) => [...existing, ...connectors]);
      },

      extractConnectors(ids) {
        const wanted = new Set(ids);
        const extracted: ExtractedConnector[] = [];
        // As with extractObjects, the updater records what it removed so the
        // caller can undo it. `set` is synchronous, so `extracted` is complete by
        // the time mutateConnectors returns.
        mutateConnectors((connectors) => {
          const kept: Connector[] = [];
          connectors.forEach((connector, index) => {
            if (wanted.has(connector.id)) extracted.push({ connector, index });
            else kept.push(connector);
          });
          return kept;
        });
        return extracted;
      },

      restoreConnectors(extracted) {
        if (extracted.length === 0) return;
        const ordered = [...extracted].sort((a, b) => a.index - b.index);
        mutateConnectors((connectors) => {
          const next = [...connectors];
          for (const { connector, index } of ordered) {
            next.splice(Math.min(index, next.length), 0, connector);
          }
          return next;
        });
      },

      connectorsTouching(objectIds) {
        const wanted = new Set(objectIds);
        return activeConnectors()
          .filter(
            (connector) =>
              wanted.has(connector.source.objectId) ||
              wanted.has(connector.target.objectId),
          )
          .map((connector) => connector.id);
      },

      setConnectorLabels(entries) {
        mutateConnectors((list) =>
          list.map((connector) =>
            // Key presence, not truthiness: an explicit `undefined` removes a
            // label, which is a different operation from leaving it alone.
            connector.id in entries
              ? { ...connector, label: entries[connector.id] }
              : connector,
          ),
        );
      },

      getConnectorLabels(ids) {
        const wanted = new Set(ids);
        const result: Record<string, TextContent | undefined> = {};
        for (const connector of activeConnectors()) {
          if (wanted.has(connector.id)) result[connector.id] = connector.label;
        }
        return result;
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
