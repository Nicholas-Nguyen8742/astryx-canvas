import { useCallback, useEffect, useState } from "react";

import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import {
  Layout,
  LayoutContent,
  LayoutFooter,
  LayoutHeader,
  LayoutPanel,
} from "@astryxdesign/core/Layout";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Theme } from "@astryxdesign/core/theme";
import { VStack } from "@astryxdesign/core/VStack";

import type {
  AppInfo,
  AutosaveEntry,
  ExportFormat,
  RecentFile,
} from "../../shared/ipc";
import { astryxTheme } from "./design-system/astryx-theme";
import {
  UNTITLED_DOCUMENT_TITLE,
  serializeDocument,
} from "./document/empty-document";
import type { ThemeMode } from "./document/model";
import { parseDocument } from "./document/validate";
import { canvasEngine } from "./editor/canvas/adapter";
import { SvgCanvas } from "./editor/canvas/SvgCanvas";
import { ExportError, exportDiagram } from "./export";
import { ExportDialog, type ExportOptions } from "./components/ExportDialog";
import { fitViewport, screenToWorld, zoomAtCenter } from "./editor/geometry";
import { useDocumentStore } from "./state/document-store";
import { useEditorStore, type ActiveTool } from "./state/editor-store";
import { useHistoryStore } from "./state/history-store";

/** TRD §16.3: autosave 2s after the last change. */
const AUTOSAVE_DEBOUNCE_MS = 2000;

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const TOOLS: readonly { tool: ActiveTool; label: string }[] = [
  { tool: "select", label: "Select" },
  { tool: "rectangle", label: "Rectangle" },
  { tool: "roundedRectangle", label: "Rounded" },
  { tool: "ellipse", label: "Ellipse" },
  { tool: "text", label: "Text" },
  { tool: "line", label: "Line" },
  { tool: "arrow", label: "Arrow" },
  { tool: "pan", label: "Pan" },
];

/** Formats offered in the rail (FR-EXP-01/02/03/04). WebP remains a COULD. */
const EXPORT_FORMATS: readonly { format: ExportFormat; label: string }[] = [
  { format: "svg", label: "Export SVG" },
  { format: "png", label: "Export PNG" },
  { format: "jpeg", label: "Export JPEG" },
  { format: "pdf", label: "Export PDF" },
];

/** FR-CANVAS-03: one toolbar step, matching a ctrl+wheel notch. */
const ZOOM_STEP = 1.25;

interface StatusMessage {
  kind: "info" | "error";
  text: string;
}

export function App(): React.JSX.Element {
  const desktop = window.astryxDesktop;

  // The document store is the single source of truth; App holds only file and
  // session concerns that are not part of the diagram itself.
  const diagram = useDocumentStore((state) => state.document);
  const isDirty = useDocumentStore((state) => state.isDirty);
  const activePageId = useDocumentStore((state) => state.activePageId);

  const canUndo = useHistoryStore((state) => state.past.length > 0);
  const canRedo = useHistoryStore((state) => state.future.length > 0);
  const undoLabel = useHistoryStore(
    (state) => state.past[state.past.length - 1]?.label,
  );
  const redoLabel = useHistoryStore((state) => state.future[0]?.label);

  const activeTool = useEditorStore((state) => state.activeTool);
  const selection = useEditorStore((state) => state.selection);
  const viewport = useEditorStore((state) => state.viewport);
  const cursorWorld = useEditorStore((state) => state.cursorWorld);
  const gridEnabled = useEditorStore((state) => state.grid.enabled);

  const [filePath, setFilePath] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recovery, setRecovery] = useState<AutosaveEntry | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("svg");

  const activePage = diagram.pages.find((page) => page.id === activePageId);
  const objectCount = activePage?.objects.length ?? 0;
  const connectorCount = activePage?.connectors.length ?? 0;

  const refreshRecent = useCallback(async (): Promise<void> => {
    if (!desktop) return;
    const result = await desktop.recent.list();
    if (result.ok) setRecentFiles(result.value);
  }, [desktop]);

  const resetSession = useCallback((): void => {
    useHistoryStore.getState().clear();
    useEditorStore.getState().clearSelection();
  }, []);

  useEffect(() => {
    if (!desktop) return;
    // StrictMode double-invokes effects in development; without this flag both
    // passes race on the same state.
    let cancelled = false;
    void (async () => {
      const info = await desktop.app.getInfo();
      if (cancelled) return;
      if (info.ok) setAppInfo(info.value);
      // Startup record (TRD §21.1) and proof that the preload bridge round-trips:
      // this only lands in renderer.log if contextBridge and ipcMain.handle are
      // both wired correctly.
      await desktop.log({
        level: "info",
        message: "Renderer mounted",
        context: { appInfo: info.ok ? info.value : info.error },
      });
      if (cancelled) return;
      await refreshRecent();
      const autosaves = await desktop.autosave.list();
      if (cancelled) return;
      if (autosaves.ok && autosaves.value.length > 0) {
        setRecovery(autosaves.value[0] ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desktop, refreshRecent]);

  // FR-FILE-06: debounce an autosave whenever the document is dirty.
  useEffect(() => {
    if (!desktop || !isDirty) return;
    const timer = window.setTimeout(() => {
      void desktop.autosave.write({
        documentId: diagram.documentId,
        contents: serializeDocument(diagram),
        originalPath: filePath,
      });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [desktop, isDirty, diagram, filePath]);

  const handleNew = useCallback((): void => {
    useDocumentStore.getState().newDocument();
    resetSession();
    setFilePath(null);
    setThemeMode("system");
    setStatus({ kind: "info", text: "Started a new blank diagram." });
  }, [resetSession]);

  const handleOpen = useCallback(async (): Promise<void> => {
    if (!desktop) return;
    const result = await desktop.dialog.openDocument();
    if (!result.ok) {
      setStatus({ kind: "error", text: result.error.message });
      return;
    }
    const { canceled, contents, filePath: opened } = result.value;
    if (canceled || contents === null || opened === null) return;

    const parsed = parseDocument(contents);
    if (!parsed.ok) {
      setStatus({ kind: "error", text: parsed.problem.message });
      await desktop.dialog.showMessage({
        kind: "error",
        title: "Cannot open this diagram",
        message: parsed.problem.message,
        detail: opened,
      });
      return;
    }

    useDocumentStore.getState().loadDocument(parsed.document);
    resetSession();
    setFilePath(opened);
    setThemeMode(parsed.document.meta.astryxTheme ?? "system");
    await refreshRecent();
    setStatus({ kind: "info", text: `Opened ${parsed.document.meta.title}.` });
  }, [desktop, refreshRecent, resetSession]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!desktop) return;
    const current = useDocumentStore.getState().document;
    const result = await desktop.dialog.saveDocument({
      filePath,
      contents: serializeDocument(current),
      suggestedName: current.meta.title || UNTITLED_DOCUMENT_TITLE,
    });
    if (!result.ok) {
      setStatus({ kind: "error", text: result.error.message });
      return;
    }
    if (result.value.canceled || result.value.filePath === null) return;

    setFilePath(result.value.filePath);
    useDocumentStore.getState().markClean();
    // The saved file is now the source of truth; the recovery copy is stale.
    await desktop.autosave.clear(current.documentId);
    await refreshRecent();
    setStatus({ kind: "info", text: `Saved ${result.value.filePath}.` });
  }, [desktop, filePath, refreshRecent]);

  const handleRestore = useCallback(async (): Promise<void> => {
    if (!desktop || !recovery) return;
    const result = await desktop.autosave.read(recovery.documentId);
    if (!result.ok) {
      setStatus({ kind: "error", text: result.error.message });
      return;
    }
    if (!result.value) {
      setRecovery(null);
      return;
    }

    const parsed = parseDocument(result.value.contents);
    if (!parsed.ok) {
      setStatus({ kind: "error", text: parsed.problem.message });
      setRecovery(null);
      return;
    }

    useDocumentStore.getState().loadDocument(parsed.document);
    resetSession();
    setFilePath(result.value.entry.originalPath);
    // loadDocument marks the document clean, but restored autosave content has
    // never been saved to a real file. Writing the theme back through setMeta
    // both applies the stored preference and leaves the document dirty, so the
    // status bar tells the truth and autosave keeps running.
    const restoredMode = parsed.document.meta.astryxTheme ?? "system";
    setThemeMode(restoredMode);
    useDocumentStore.getState().setMeta({ astryxTheme: restoredMode });
    setRecovery(null);
    setStatus({ kind: "info", text: "Restored unsaved work from autosave." });
  }, [desktop, recovery, resetSession]);

  const handleDiscardRecovery = useCallback(async (): Promise<void> => {
    if (!desktop || !recovery) return;
    const result = await desktop.autosave.clear(recovery.documentId);
    setRecovery(null);
    if (!result.ok) setStatus({ kind: "error", text: result.error.message });
    else setStatus({ kind: "info", text: "Discarded the autosaved session." });
  }, [desktop, recovery]);

  /** Theme choice is document metadata (§12.1), so changing it dirties the file. */
  const applyThemeMode = useCallback((mode: ThemeMode): void => {
    setThemeMode(mode);
    useDocumentStore.getState().setMeta({ astryxTheme: mode });
  }, []);

  const handleUndo = useCallback(
    (): void => useHistoryStore.getState().undo(),
    [],
  );
  const handleRedo = useCallback(
    (): void => useHistoryStore.getState().redo(),
    [],
  );

  const zoomByCentered = useCallback((factor: number): void => {
    const editor = useEditorStore.getState();
    editor.setViewport(
      zoomAtCenter(editor.viewport, editor.viewportSize, factor),
    );
  }, []);

  // FR-CANVAS-08: fit the drawing's real bounds, not the whole infinite canvas.
  const handleFit = useCallback((): void => {
    const editor = useEditorStore.getState();
    const current = useDocumentStore.getState();
    const page = current.document.pages.find(
      (p) => p.id === current.activePageId,
    );
    const bounds = canvasEngine.getContentBounds(page?.objects ?? []);
    editor.setViewport(fitViewport(bounds, editor.viewportSize));
  }, []);

  const handleResetZoom = useCallback((): void => {
    useEditorStore.getState().resetZoom();
  }, []);

  const handleToggleGrid = useCallback((): void => {
    useEditorStore.getState().toggleGrid();
  }, []);

  /**
   * FR-EXP-01..04. An export failure surfaces as a message the user can act on
   * (FR-EXP-18) — an empty canvas, a refused save, or a raster too large to
   * allocate all need different responses, and none of them is a stack trace.
   */
  const openExportDialog = useCallback((format: ExportFormat): void => {
    setExportFormat(format);
    setExportDialogOpen(true);
  }, []);

  const handleExportRequest = useCallback(
    async (options: ExportOptions): Promise<void> => {
      if (!desktop) return;
      const doc = useDocumentStore.getState();
      const editor = useEditorStore.getState();
      const page = doc.document.pages.find(
        (entry) => entry.id === doc.activePageId,
      );

      // Viewport scope crops to what is on screen, which only the canvas element
      // size and the live pan and zoom can supply (FR-EXP-06).
      const origin = screenToWorld({ x: 0, y: 0 }, editor.viewport);
      const viewportBounds = {
        x: origin.x,
        y: origin.y,
        width: editor.viewportSize.x / editor.viewport.zoom,
        height: editor.viewportSize.y / editor.viewport.zoom,
      };

      try {
        const outcome = await exportDiagram(
          desktop,
          page?.objects ?? [],
          editor.selection,
          doc.document.meta.title,
          { ...options, viewportBounds },
        );
        if (outcome.canceled) {
          setStatus({ kind: "info", text: "Export cancelled." });
          return;
        }
        const kilobytes = Math.max(1, Math.round(outcome.bytes / 1024));
        setStatus({
          kind: "info",
          text: `Exported ${options.format.toUpperCase()} to ${outcome.filePath} (${kilobytes} kB).`,
        });
      } catch (cause) {
        const message =
          cause instanceof ExportError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : "Export failed for an unknown reason.";
        setStatus({ kind: "error", text: message });
        await desktop.dialog.showMessage({
          kind: "error",
          title: "Export failed",
          message,
        });
      }
    },
    [desktop],
  );

  const selectTool = useCallback((tool: ActiveTool): void => {
    useEditorStore.getState().setTool(tool);
  }, []);

  // FR-PROD-01 / §19.1. Native menus will own these later; the renderer binding
  // keeps them working until then.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        handleNew();
      } else if (key === "o") {
        event.preventDefault();
        void handleOpen();
      } else if (key === "s" && !event.shiftKey) {
        event.preventDefault();
        void handleSave();
      } else if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNew, handleOpen, handleSave, handleUndo, handleRedo]);

  if (!desktop) {
    return (
      <Theme theme={astryxTheme} mode="system">
        <Center>
          <VStack gap={3}>
            <Heading level={2}>Desktop bridge unavailable</Heading>
            <Text type="body" color="secondary">
              window.astryxDesktop was not injected. This app has to run inside
              Electron with the preload script loaded; file access never happens
              in the renderer.
            </Text>
          </VStack>
        </Center>
      </Theme>
    );
  }

  const fileName = filePath
    ? (filePath.split(/[\\/]/).pop() ?? filePath)
    : UNTITLED_DOCUMENT_TITLE;
  const zoomPercent = Math.round(viewport.zoom * 100);

  return (
    <Theme theme={astryxTheme} mode={themeMode}>
      <Layout
        header={
          <LayoutHeader hasDivider>
            <HStack gap={2} vAlign="center">
              <Heading level={3} maxLines={1}>
                {diagram.meta.title}
              </Heading>
              <Text type="supporting" color="secondary">
                {isDirty ? "Unsaved changes" : "Saved"}
              </Text>
              <StackItem size="fill" />
              <Button
                label={undoLabel ? `Undo ${undoLabel}` : "Undo"}
                size="sm"
                isDisabled={!canUndo}
                onClick={handleUndo}
              />
              <Button
                label={redoLabel ? `Redo ${redoLabel}` : "Redo"}
                size="sm"
                isDisabled={!canRedo}
                onClick={handleRedo}
              />
              <Button label="New diagram" size="sm" onClick={handleNew} />
              <Button label="Open diagram" size="sm" clickAction={handleOpen} />
              <Button
                label="Save diagram"
                size="sm"
                variant="primary"
                clickAction={handleSave}
              />
              {THEME_MODES.map((mode) => (
                <Button
                  key={mode}
                  label={`${THEME_MODE_LABEL[mode]} theme`}
                  size="sm"
                  variant={themeMode === mode ? "secondary" : "ghost"}
                  onClick={() => applyThemeMode(mode)}
                />
              ))}
            </HStack>
          </LayoutHeader>
        }
        start={
          <LayoutPanel
            hasDivider
            width={220}
            role="navigation"
            label="Tools and stencils"
          >
            <VStack gap={3}>
              <Heading level={5}>Tools</Heading>
              <VStack gap={1}>
                {TOOLS.map((entry) => (
                  <Button
                    key={entry.tool}
                    label={entry.label}
                    size="sm"
                    width="100%"
                    variant={activeTool === entry.tool ? "primary" : "ghost"}
                    onClick={() => selectTool(entry.tool)}
                  />
                ))}
              </VStack>

              <Heading level={5}>View</Heading>
              <VStack gap={1}>
                <Button
                  label="Zoom in"
                  size="sm"
                  width="100%"
                  onClick={() => zoomByCentered(ZOOM_STEP)}
                />
                <Button
                  label="Zoom out"
                  size="sm"
                  width="100%"
                  onClick={() => zoomByCentered(1 / ZOOM_STEP)}
                />
                <Button
                  label="Fit to screen"
                  size="sm"
                  width="100%"
                  onClick={handleFit}
                />
                <Button
                  label="Reset to 100%"
                  size="sm"
                  width="100%"
                  onClick={handleResetZoom}
                />
                <Button
                  label={gridEnabled ? "Hide grid" : "Show grid"}
                  size="sm"
                  width="100%"
                  onClick={handleToggleGrid}
                />
              </VStack>

              <Heading level={5}>Export</Heading>
              <VStack gap={1}>
                {EXPORT_FORMATS.map((entry) => (
                  <Button
                    key={entry.format}
                    label={entry.label}
                    size="sm"
                    width="100%"
                    clickAction={() => openExportDialog(entry.format)}
                  />
                ))}
              </VStack>

              <Heading level={5}>Recent</Heading>
              {recentFiles.length === 0 ? (
                <Text type="supporting" color="secondary">
                  No recent diagrams yet.
                </Text>
              ) : (
                <VStack gap={1}>
                  {recentFiles.slice(0, 6).map((entry) => (
                    <Text key={entry.path} type="supporting" maxLines={1}>
                      {entry.title}
                    </Text>
                  ))}
                </VStack>
              )}
            </VStack>
          </LayoutPanel>
        }
        end={
          <LayoutPanel
            hasDivider
            width={260}
            role="complementary"
            label="Inspector"
          >
            <VStack gap={3}>
              <Heading level={5}>Inspector</Heading>
              <Text type="supporting" color="secondary">
                {selection.length === 0
                  ? "Nothing selected. Draw a shape from the tool rail, then select it to edit its geometry and style."
                  : `${selection.length} object${selection.length === 1 ? "" : "s"} selected. Style controls arrive with the inspector milestone.`}
              </Text>
            </VStack>
          </LayoutPanel>
        }
        content={
          <LayoutContent isScrollable={false}>
            <VStack gap={2} className="canvas-region">
              {recovery ? (
                <HStack gap={2} vAlign="center">
                  <StackItem size="fill">
                    <Text type="body">
                      Unsaved work from a previous session was recovered (
                      {recovery.lastSavedAt}).
                    </Text>
                  </StackItem>
                  <Button
                    label="Restore autosaved work"
                    size="sm"
                    variant="primary"
                    clickAction={handleRestore}
                  />
                  <Button
                    label="Discard autosaved work"
                    size="sm"
                    variant="ghost"
                    clickAction={handleDiscardRecovery}
                  />
                </HStack>
              ) : null}
              {status ? (
                <Text
                  type="body"
                  color="secondary"
                  className={
                    status.kind === "error"
                      ? "status-message status-error"
                      : "status-message"
                  }
                >
                  {status.text}
                </Text>
              ) : null}
              {/* StackItem size="fill" is what gives the canvas the leftover
                  height; without it the host collapses to the SVG default of
                  150px and most of the drawing surface is unreachable. */}
              <StackItem size="fill">
                <SvgCanvas />
              </StackItem>
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={3} vAlign="center">
              <Text type="supporting" color="secondary" maxLines={1}>
                {fileName}
              </Text>
              <StackItem size="fill" />
              <Text type="supporting" color="secondary">
                {objectCount} objects
              </Text>
              <Text type="supporting" color="secondary">
                {connectorCount} connectors
              </Text>
              <Text type="supporting" color="secondary">
                {selection.length} selected
              </Text>
              <Text type="supporting" color="secondary">
                {cursorWorld
                  ? `x ${Math.round(cursorWorld.x)}  y ${Math.round(cursorWorld.y)}`
                  : "x —  y —"}
              </Text>
              <Text type="supporting" color="secondary">
                {zoomPercent}%
              </Text>
              <Text type="supporting" color="secondary">
                {appInfo ? `v${appInfo.version}` : ""}
              </Text>
            </HStack>
          </LayoutFooter>
        }
      />

      <ExportDialog
        isOpen={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        initialFormat={exportFormat}
        hasSelection={selection.length > 0}
        onExport={handleExportRequest}
      />
    </Theme>
  );
}
