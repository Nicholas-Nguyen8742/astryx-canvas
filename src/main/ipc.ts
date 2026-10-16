import { app, dialog, ipcMain, shell, type BrowserWindow } from "electron";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  DOCUMENT_FILTER,
  IpcChannel,
  err,
  ok,
  type AppInfo,
  type AutosaveEntry,
  type AutosaveReadResult,
  type IpcErrorCode,
  type IpcResult,
  type LogLevel,
  type MessageKind,
  type MessageOptions,
  type OpenDocumentResult,
  type RecentFile,
  type SaveDocumentRequest,
  type SaveDocumentResult,
  type WriteDocumentRequest,
} from "../shared/ipc";
import type { FileLogger } from "./logger";
import { appPaths } from "./paths";
import { grantFile, grantRoot, isPathGranted } from "./path-guard";
import { atomicWriteText } from "./atomic-write";
import { addRecent, listRecent, removeRecent } from "./store-recent";
import {
  clearAutosave,
  isSafeDocumentId,
  listAutosave,
  readAutosave,
  writeAutosave,
} from "./store-autosave";

class InvalidArgument extends Error {}
class PathNotGranted extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidArgument(`Expected a non-empty string for "${field}".`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new InvalidArgument("Expected an object argument.");
  }
  return value as Record<string, unknown>;
}

const MESSAGE_KINDS = [
  "info",
  "warning",
  "error",
] as const satisfies readonly MessageKind[];
const LOG_LEVELS = [
  "error",
  "warn",
  "info",
  "debug",
] as const satisfies readonly LogLevel[];

/**
 * Narrows an arbitrary IPC string to one of a fixed set of literals. TypeScript
 * cannot subtract literals from `string` by exclusion, so the membership test has
 * to happen here for the result to actually carry a union type.
 */
function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const raw = requireString(value, field);
  const match = allowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new InvalidArgument(
      `Unsupported ${field} "${raw}". Expected one of: ${allowed.join(", ")}.`,
    );
  }
  return match;
}

function errorCode(cause: unknown): { code: IpcErrorCode; message: string } {
  if (cause instanceof InvalidArgument) {
    return { code: "invalid-argument", message: cause.message };
  }
  if (cause instanceof PathNotGranted) {
    return { code: "path-not-granted", message: cause.message };
  }

  const detail = cause instanceof Error ? cause.message : String(cause);
  const fsCode =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined;

  if (fsCode === "ENOENT") {
    return { code: "not-found", message: `No such file: ${detail}` };
  }
  if (typeof fsCode === "string") {
    return { code: "io", message: `Filesystem error ${fsCode}: ${detail}` };
  }
  return {
    code: "internal",
    message: detail.length > 0 ? detail : "Unexpected error.",
  };
}

/** Best-effort document title for the recent list; never throws on bad JSON. */
function titleFromContents(contents: string, fallbackPath: string): string {
  try {
    const parsed = JSON.parse(contents) as { meta?: { title?: unknown } };
    if (
      typeof parsed.meta?.title === "string" &&
      parsed.meta.title.length > 0
    ) {
      return parsed.meta.title;
    }
  } catch {
    // Not JSON, or not ours. The filename is a perfectly good title.
  }
  return basename(fallbackPath).replace(/\.astrx$/i, "");
}

async function recordRecent(filePath: string, contents: string): Promise<void> {
  const entry: RecentFile = {
    path: filePath,
    title: titleFromContents(contents, filePath),
    lastOpened: new Date().toISOString(),
  };
  await addRecent(entry);
}

function assertGranted(filePath: string): string {
  const resolved = resolve(filePath);
  if (!isPathGranted(resolved)) {
    throw new PathNotGranted(
      `Access to "${resolved}" was not granted by a file dialog or the app's own storage.`,
    );
  }
  return resolved;
}

export interface RegisterIpcOptions {
  getWindow: () => BrowserWindow | null;
  logger: FileLogger;
  rendererLogger: FileLogger;
}

export function registerIpcHandlers({
  getWindow,
  logger,
  rendererLogger,
}: RegisterIpcOptions): void {
  // Our own storage is always reachable; everything else must be dialog-granted.
  grantRoot(appPaths.autosaveDir);
  grantRoot(appPaths.logDir);

  const wrap = <TValue>(
    channel: string,
    handler: (args: unknown) => Promise<TValue>,
  ): void => {
    ipcMain.handle(
      channel,
      async (_event, args: unknown): Promise<IpcResult<TValue>> => {
        try {
          return ok(await handler(args));
        } catch (cause) {
          const { code, message } = errorCode(cause);
          logger.warn("IPC handler failed", { channel, code, message });
          return err<TValue>(code, message);
        }
      },
    );
  };

  wrap<AppInfo>(IpcChannel.AppGetInfo, async () => ({
    name: app.getName(),
    version: app.getVersion(),
  }));

  wrap<OpenDocumentResult>(IpcChannel.DialogOpenDocument, async () => {
    const parent = getWindow();
    const options = {
      title: "Open Diagram",
      defaultPath: app.getPath("documents"),
      filters: [DOCUMENT_FILTER, { name: "All Files", extensions: ["*"] }],
      properties: ["openFile" as const],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: null, contents: null };
    }

    const filePath = resolve(result.filePaths[0]!);
    const contents = await readFile(filePath, "utf8");
    grantFile(filePath);
    await recordRecent(filePath, contents);
    logger.info("Opened document", { path: filePath, bytes: contents.length });
    return { canceled: false, filePath, contents };
  });

  wrap<SaveDocumentResult>(IpcChannel.DialogSaveDocument, async (args) => {
    const request = asRecord(args) as unknown as Partial<SaveDocumentRequest>;
    const contents = requireString(request.contents, "contents");
    const requested = nullableString(request.filePath, "filePath");
    const suggestedName = optionalString(
      request.suggestedName,
      "suggestedName",
    );

    let filePath = requested ? assertGranted(requested) : null;

    if (filePath === null) {
      const parent = getWindow();
      const options = {
        title: "Save Diagram",
        defaultPath: resolve(
          app.getPath("documents"),
          `${suggestedName ?? "Untitled Diagram"}.astrx`,
        ),
        filters: [DOCUMENT_FILTER],
        properties: ["createDirectory" as const],
      };
      const result = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        return { canceled: true, filePath: null };
      }
      filePath = resolve(result.filePath);
      grantFile(filePath);
    }

    // Back up only when overwriting a file we did not just create.
    await atomicWriteText(filePath, contents, { backup: requested !== null });
    await recordRecent(filePath, contents);
    logger.info("Saved document", { path: filePath, bytes: contents.length });
    return { canceled: false, filePath };
  });

  wrap<void>(IpcChannel.DialogMessage, async (args) => {
    const options = asRecord(args) as unknown as Partial<MessageOptions>;
    const kind = requireEnum(options.kind, MESSAGE_KINDS, "message kind");
    const parent = getWindow();
    const box = {
      type: kind,
      title: requireString(options.title, "title"),
      message: requireString(options.message, "message"),
      detail: optionalString(options.detail, "detail"),
      buttons: ["OK"],
      noLink: true,
    };
    if (parent) await dialog.showMessageBox(parent, box);
    else await dialog.showMessageBox(box);
  });

  wrap<string>(IpcChannel.DocumentRead, async (args) => {
    const filePath = assertGranted(
      requireString(asRecord(args).filePath, "filePath"),
    );
    return readFile(filePath, "utf8");
  });

  wrap<void>(IpcChannel.DocumentWrite, async (args) => {
    const request = asRecord(args) as unknown as Partial<WriteDocumentRequest>;
    const filePath = assertGranted(requireString(request.filePath, "filePath"));
    const contents = requireString(request.contents, "contents");
    await atomicWriteText(filePath, contents, { backup: true });
    await recordRecent(filePath, contents);
  });

  wrap<RecentFile[]>(IpcChannel.RecentList, async () => {
    const entries = await listRecent();
    // Re-grant so a path picked from the recent list can be read immediately.
    for (const entry of entries) grantFile(entry.path);
    return entries;
  });

  wrap<void>(IpcChannel.RecentRemove, async (args) => {
    await removeRecent(requireString(args, "path"));
  });

  wrap<AutosaveEntry[]>(IpcChannel.AutosaveList, () => listAutosave());

  wrap<void>(IpcChannel.AutosaveWrite, async (args) => {
    const request = asRecord(args);
    const documentId = requireString(request.documentId, "documentId");
    const contents = requireString(request.contents, "contents");
    const originalPath = nullableString(request.originalPath, "originalPath");
    if (!isSafeDocumentId(documentId)) {
      throw new InvalidArgument(`"${documentId}" is not a valid document id.`);
    }
    await writeAutosave(documentId, contents, originalPath);
  });

  wrap<AutosaveReadResult | null>(IpcChannel.AutosaveRead, async (args) => {
    const documentId = requireString(args, "documentId");
    if (!isSafeDocumentId(documentId)) {
      throw new InvalidArgument(`"${documentId}" is not a valid document id.`);
    }
    return readAutosave(documentId);
  });

  wrap<void>(IpcChannel.AutosaveClear, async (args) => {
    const documentId = requireString(args, "documentId");
    if (!isSafeDocumentId(documentId)) {
      throw new InvalidArgument(`"${documentId}" is not a valid document id.`);
    }
    await clearAutosave(documentId);
  });

  wrap<void>(IpcChannel.ShellShowItemInFolder, async (args) => {
    const filePath = assertGranted(requireString(args, "path"));
    shell.showItemInFolder(filePath);
  });

  wrap<void>(IpcChannel.LogWrite, async (args) => {
    const record = asRecord(args);
    const level = requireEnum(record.level, LOG_LEVELS, "log level");
    const message = requireString(record.message, "message");
    const context =
      typeof record.context === "object" && record.context !== null
        ? (record.context as Record<string, unknown>)
        : undefined;
    rendererLogger.write(level, message, context);
  });
}
