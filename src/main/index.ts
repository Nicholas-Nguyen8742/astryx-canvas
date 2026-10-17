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

/**
 * Automation affordance: lets an E2E run point the app at a throwaway profile so
 * its autosave, logs and recent files never touch real user data — and so a
 * previous run's autosave cannot surface the recovery dialog into the next one.
 * Must run before the first `getPath('userData')` call below.
 */
const userDataOverride = process.env.ASTRYX_USER_DATA;
if (userDataOverride && userDataOverride.length > 0) {
  app.setPath("userData", userDataOverride);
}

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

// Set once we have taken over shutting down, so the second before-quit that our
// own app.quit() triggers is allowed through instead of being blocked again.
let isFlushingBeforeQuit = false;

app.on("before-quit", (event) => {
  if (isFlushingBeforeQuit) return;
  isFlushingBeforeQuit = true;

  // Block this quit, flush the log queue so the shutdown record reaches disk,
  // then quit again. Without the guard above this loops forever, because
  // `pending` can never have settled by the time the synchronous check runs.
  event.preventDefault();
  void Promise.all([logger.flush(), rendererLogger.flush()]).finally(() =>
    app.quit(),
  );
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
