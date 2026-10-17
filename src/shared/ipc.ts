/**
 * Typed IPC contract between the Electron main process and the renderer.
 *
 * Every channel name is a constant (TRD §17.2 rule 1) and every call resolves to
 * a discriminated `IpcResult` rather than throwing across the context bridge, so
 * the renderer always gets an actionable, typed error (rule 7, NFR-USE-04).
 */

export const IpcChannel = {
  AppGetInfo: "app:get-info",
  DialogOpenDocument: "dialog:open-document",
  DialogSaveDocument: "dialog:save-document",
  DialogMessage: "dialog:message",
  DocumentRead: "document:read",
  DocumentWrite: "document:write",
  RecentList: "recent:list",
  RecentRemove: "recent:remove",
  AutosaveList: "autosave:list",
  AutosaveWrite: "autosave:write",
  AutosaveRead: "autosave:read",
  AutosaveClear: "autosave:clear",
  ShellShowItemInFolder: "shell:show-item-in-folder",
  ExportSaveBlob: "export:save-blob",
  PdfPrintToPdf: "pdf:print-to-pdf",
  LogWrite: "log:write",
} as const;

export type IpcChannelValue = (typeof IpcChannel)[keyof typeof IpcChannel];

export type IpcErrorCode =
  "invalid-argument" | "path-not-granted" | "not-found" | "io" | "internal";

export interface IpcError {
  code: IpcErrorCode;
  /** Human-readable and actionable; safe to show directly to the user. */
  message: string;
}

export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: IpcError };

export const DOCUMENT_EXTENSION = "astrx";

/**
 * Typed loosely on purpose: Electron's `FileFilter.extensions` is a mutable
 * `string[]`, so an `as const` tuple here would not be assignable to the dialog
 * options without a spread at every call site.
 */
export const DOCUMENT_FILTER: { name: string; extensions: string[] } = {
  name: "Astryx Diagram",
  extensions: [DOCUMENT_EXTENSION],
};

export interface AppInfo {
  name: string;
  version: string;
}

export interface OpenDocumentResult {
  canceled: boolean;
  /** Null when the user cancelled. */
  filePath: string | null;
  /** Read by the main process; the renderer never touches the filesystem. */
  contents: string | null;
}

export interface SaveDocumentRequest {
  /** Omitted for Save, supplied for Save As. Null when no file is open yet. */
  filePath: string | null;
  contents: string;
  /** Used as the dialog's default filename when saving a new document. */
  suggestedName?: string;
}

export interface SaveDocumentResult {
  canceled: boolean;
  filePath: string | null;
}

export interface WriteDocumentRequest {
  filePath: string;
  contents: string;
}

export type MessageKind = "info" | "warning" | "error";

export interface MessageOptions {
  kind: MessageKind;
  title: string;
  message: string;
  detail?: string;
}

export interface RecentFile {
  path: string;
  title: string;
  /** ISO 8601. */
  lastOpened: string;
}

export interface AutosaveEntry {
  documentId: string;
  /** ISO 8601. */
  lastSavedAt: string;
  originalPath: string | null;
}

export interface AutosaveWriteRequest {
  documentId: string;
  contents: string;
  originalPath: string | null;
}

export interface AutosaveReadResult {
  entry: AutosaveEntry;
  contents: string;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogRecord {
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

/** Export formats the save dialog offers (FR-EXP-02/03/04/05). */
export type ExportFormat = "svg" | "png" | "jpeg" | "pdf";

export interface SaveBlobRequest {
  suggestedName: string;
  format: ExportFormat;
  /**
   * Transferred as an ArrayBuffer rather than base64 (TRD §17.2 rule 6): a 4K
   * raster is megabytes, and base64 would inflate it by a third on top of a
   * string copy through the bridge.
   */
  data: ArrayBuffer;
}

export interface SaveBlobResult {
  canceled: boolean;
  filePath: string | null;
}

/** TRD FR-EXP-07/08/09. */
export type PdfPageSize = "A3" | "A4" | "Letter" | "Legal";
export type PdfOrientation = "portrait" | "landscape";

export interface PdfPrintRequest {
  /** Standalone SVG markup, generated in the renderer by the canvas engine. */
  svg: string;
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  /** Page margin in points (1/72 inch). */
  marginPoints: number;
}

/**
 * The single surface exposed on `window.astryxDesktop` (TRD §17.1). Nothing here
 * hands the renderer a raw path it did not already receive from a dialog or from
 * our own stores.
 */
export interface DesktopApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>;
  };
  dialog: {
    openDocument(): Promise<IpcResult<OpenDocumentResult>>;
    saveDocument(
      request: SaveDocumentRequest,
    ): Promise<IpcResult<SaveDocumentResult>>;
    showMessage(options: MessageOptions): Promise<IpcResult<void>>;
  };
  document: {
    read(filePath: string): Promise<IpcResult<string>>;
    write(request: WriteDocumentRequest): Promise<IpcResult<void>>;
  };
  recent: {
    list(): Promise<IpcResult<RecentFile[]>>;
    remove(path: string): Promise<IpcResult<void>>;
  };
  autosave: {
    list(): Promise<IpcResult<AutosaveEntry[]>>;
    write(request: AutosaveWriteRequest): Promise<IpcResult<void>>;
    read(documentId: string): Promise<IpcResult<AutosaveReadResult | null>>;
    clear(documentId: string): Promise<IpcResult<void>>;
  };
  shell: {
    showItemInFolder(path: string): Promise<IpcResult<void>>;
  };
  export: {
    saveBlob(request: SaveBlobRequest): Promise<IpcResult<SaveBlobResult>>;
  };
  pdf: {
    printToPdf(request: PdfPrintRequest): Promise<IpcResult<ArrayBuffer>>;
  };
  log: (record: LogRecord) => Promise<IpcResult<void>>;
}

export const DESKTOP_API_KEY = "astryxDesktop";

export function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

export function err<T>(code: IpcErrorCode, message: string): IpcResult<T> {
  return { ok: false, error: { code, message } };
}
