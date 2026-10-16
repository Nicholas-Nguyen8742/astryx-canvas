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

import type { AppInfo, AutosaveEntry, RecentFile } from "../../shared/ipc";
import { astryxTheme } from "./design-system/astryx-theme";
import {
  UNTITLED_DOCUMENT_TITLE,
  createEmptyDocument,
  serializeDocument,
} from "./document/empty-document";
import type { DiagramDocument, ThemeMode } from "./document/model";
import { parseDocument } from "./document/validate";

/** TRD §16.3: autosave 2s after the last change. */
const AUTOSAVE_DEBOUNCE_MS = 2000;

const THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

interface StatusMessage {
  kind: "info" | "error";
  text: string;
}

export function App(): React.JSX.Element {
  const desktop = window.astryxDesktop;

  const [diagram, setDiagram] = useState<DiagramDocument>(() =>
    createEmptyDocument(),
  );
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recovery, setRecovery] = useState<AutosaveEntry | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const refreshRecent = useCallback(async (): Promise<void> => {
    if (!desktop) return;
    const result = await desktop.recent.list();
    if (result.ok) setRecentFiles(result.value);
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    // StrictMode double-invokes effects in development. Without this flag both
    // passes run to completion and race each other on the same state, which is
    // harmless for these read-only startup calls but would not stay harmless
    // once the effect grows side effects.
    let cancelled = false;
    void (async () => {
      const info = await desktop.app.getInfo();
      if (cancelled) return;
      if (info.ok) setAppInfo(info.value);
      // Startup record (TRD §21.1). Also the proof that the preload bridge
      // round-trips: this only lands in renderer.log if contextBridge and the
      // matching ipcMain.handle are both wired correctly.
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
        // Newest first, per store-autosave ordering.
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
    const blank = createEmptyDocument();
    setDiagram(blank);
    setFilePath(null);
    setIsDirty(false);
    setThemeMode(blank.meta.astryxTheme ?? "system");
    setStatus({ kind: "info", text: "Started a new blank diagram." });
  }, []);

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

    setDiagram(parsed.document);
    setFilePath(opened);
    setIsDirty(false);
    setThemeMode(parsed.document.meta.astryxTheme ?? "system");
    await refreshRecent();
    setStatus({ kind: "info", text: `Opened ${parsed.document.meta.title}.` });
  }, [desktop, refreshRecent]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!desktop) return;
    const contents = serializeDocument(diagram);
    const result = await desktop.dialog.saveDocument({
      filePath,
      contents,
      suggestedName: diagram.meta.title || UNTITLED_DOCUMENT_TITLE,
    });
    if (!result.ok) {
      setStatus({ kind: "error", text: result.error.message });
      return;
    }
    if (result.value.canceled || result.value.filePath === null) return;

    setFilePath(result.value.filePath);
    setIsDirty(false);
    // The saved file is now the source of truth; the recovery copy is stale.
    await desktop.autosave.clear(diagram.documentId);
    await refreshRecent();
    setStatus({ kind: "info", text: `Saved ${result.value.filePath}.` });
  }, [desktop, diagram, filePath, refreshRecent]);

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

    setDiagram(parsed.document);
    setFilePath(result.value.entry.originalPath);
    setThemeMode(parsed.document.meta.astryxTheme ?? "system");
    setIsDirty(true);
    setRecovery(null);
    setStatus({ kind: "info", text: "Restored unsaved work from autosave." });
  }, [desktop, recovery]);

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
    setDiagram((current) => ({
      ...current,
      meta: { ...current.meta, astryxTheme: mode },
    }));
    setIsDirty(true);
  }, []);

  // FR-PROD-01 / §19.1. Native menus will own these later; the renderer binding
  // keeps them working until then.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
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
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNew, handleOpen, handleSave]);

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

  const page = diagram.pages[0];
  const objectCount = page?.objects.length ?? 0;
  const connectorCount = page?.connectors.length ?? 0;
  const zoomPercent = Math.round((page?.viewport.zoom ?? 1) * 100);
  const fileName = filePath
    ? (filePath.split(/[\\/]/).pop() ?? filePath)
    : UNTITLED_DOCUMENT_TITLE;

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
            width={248}
            role="navigation"
            label="Stencil library"
          >
            <VStack gap={3}>
              <Heading level={5}>Architecture stencils</Heading>
              <Text type="supporting" color="secondary">
                The stencil library arrives with Milestone 3 (FR-ARCH-01).
                Placement, ports and connector attachment are wired to the
                canvas engine there.
              </Text>
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
            width={280}
            role="complementary"
            label="Inspector"
          >
            <VStack gap={3}>
              <Heading level={5}>Inspector</Heading>
              <Text type="supporting" color="secondary">
                Nothing selected. Object, connector and document styling
                controls land with the canvas engine (FR-STYLE-01).
              </Text>
            </VStack>
          </LayoutPanel>
        }
        content={
          <LayoutContent>
            <VStack gap={2}>
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
                    status.kind === "error" ? "status-error" : undefined
                  }
                >
                  {status.text}
                </Text>
              ) : null}
              <div className="canvas-host">
                <Center>
                  <VStack gap={2}>
                    <Heading level={4}>Blank canvas</Heading>
                    <Text type="supporting" color="secondary">
                      Pan, zoom, grid and object tools arrive with the canvas
                      engine adapter (Milestone 2, NFR-MAINT-05).
                    </Text>
                  </VStack>
                </Center>
              </div>
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
                {zoomPercent}%
              </Text>
              <Text type="supporting" color="secondary">
                {appInfo ? `v${appInfo.version}` : ""}
              </Text>
            </HStack>
          </LayoutFooter>
        }
      />
    </Theme>
  );
}
