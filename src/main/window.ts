import { BrowserWindow, shell } from "electron";
import { join } from "node:path";

import type { FileLogger } from "./logger";
import { hardenWebContents } from "./security";

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 960;
const MIN_HEIGHT = 600;

export interface CreateWindowOptions {
  logger: FileLogger;
}

export function createMainWindow({
  logger,
}: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: false,
    title: "Astryx Architecture Canvas",
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      // NFR-SEC-01/02/03: no Node in the renderer, isolated contexts, sandboxed.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Offline app: never reach out for spelling dictionaries.
      spellcheck: false,
    },
  });

  hardenWebContents(window.webContents, logger);

  window.once("ready-to-show", () => {
    window.show();
  });

  window.webContents.on(
    "did-fail-load",
    (_event, code, description, validatedUrl) => {
      logger.error("Renderer failed to load", {
        code,
        description,
        validatedUrl,
      });
    },
  );

  window.webContents.on("render-process-gone", (_event, details) => {
    // NFR-REL-01: a gone renderer is recoverable because autosave is on disk.
    logger.error("Renderer process gone", {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  return window;
}

/**
 * Kept deliberately narrow: an offline tool should not hand arbitrary renderer
 * strings to the OS. External links are surfaced through the shell only from
 * main-process code paths that constructed the URL themselves.
 */
export async function openExternal(
  url: string,
  logger: FileLogger,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    logger.warn("Refused to open external URL with disallowed protocol", {
      protocol: parsed.protocol,
    });
    return;
  }
  await shell.openExternal(url);
}
