import { app, BrowserWindow } from "electron";
import { join } from "node:path";

import { FileLogger } from "./logger";
import { appPaths } from "./paths";
import { registerIpcHandlers } from "./ipc";
import { applyContentSecurityPolicy, contentSecurityPolicy } from "./security";
import { createMainWindow } from "./window";

/**
 * Must happen before the first `app.getPath('userData')` call, because that path
 * is derived from the app name and every autosave, log and recent-file location
 * hangs off it (TRD §16.3, §21.1).
 */
app.setName("Astryx Architecture Canvas");

const isDev = !app.isPackaged;
const logLevel = isDev ? "debug" : "info";

const logger = new FileLogger(appPaths.mainLog, logLevel);
const rendererLogger = new FileLogger(appPaths.rendererLog, logLevel);

let mainWindow: BrowserWindow | null = null;

function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

app.on("ready", () => {
  logger.info("App ready", { version: app.getVersion(), isDev });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  applyContentSecurityPolicy(
    contentSecurityPolicy(isDev ? "development" : "production", devServerUrl),
  );

  registerIpcHandlers({ getWindow, logger, rendererLogger });

  mainWindow = createMainWindow({ logger });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(
      join(import.meta.dirname, "../renderer/index.html"),
    );
  }
});

app.on("window-all-closed", () => {
  // macOS keeps the app resident with no windows, matching platform convention.
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (getWindow() === null && app.isReady()) {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    mainWindow = createMainWindow({ logger });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    if (devServerUrl) void mainWindow.loadURL(devServerUrl);
    else
      void mainWindow.loadFile(
        join(import.meta.dirname, "../renderer/index.html"),
      );
  }
});

app.on("before-quit", (event) => {
  // Flush the log queue so the shutdown record actually reaches disk.
  const pending = Promise.all([logger.flush(), rendererLogger.flush()]);
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  if (!settled) {
    event.preventDefault();
    void pending.finally(() => app.quit());
  }
});

// A document editor should reuse one process; a second launch focuses the first.
const acquiredLock = app.requestSingleInstanceLock();
if (!acquiredLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = getWindow();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
}

// Fail loud locally, never outward: no crash reporter, no telemetry (NFR-SEC-10).
process.on("uncaughtException", (cause) => {
  logger.error("Uncaught exception in main", {
    message: cause instanceof Error ? cause.message : String(cause),
    stack: cause instanceof Error ? cause.stack : undefined,
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection in main", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});
