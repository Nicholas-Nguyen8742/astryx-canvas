import { contextBridge, ipcRenderer } from "electron";

import {
  DESKTOP_API_KEY,
  IpcChannel,
  type AppInfo,
  type AutosaveEntry,
  type AutosaveReadResult,
  type AutosaveWriteRequest,
  type DesktopApi,
  type IpcResult,
  type LogRecord,
  type MessageOptions,
  type OpenDocumentResult,
  type RecentFile,
  type SaveDocumentRequest,
  type SaveDocumentResult,
  type WriteDocumentRequest,
} from "../shared/ipc";

/**
 * The only seam between the renderer and privileged code (NFR-SEC-04/05).
 *
 * `ipcRenderer.invoke` is untyped at the boundary; the cast is safe because both
 * sides are generated from the same `DesktopApi` contract in `src/shared/ipc.ts`.
 * No raw `ipcRenderer`, `require`, `process` or `fs` is ever handed over.
 */
function invoke<TValue>(channel: string, ...args: unknown[]): Promise<IpcResult<TValue>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<TValue>>;
}

const desktopApi: DesktopApi = {
  app: {
    getInfo: () => invoke<AppInfo>(IpcChannel.AppGetInfo),
  },
  dialog: {
    openDocument: () => invoke<OpenDocumentResult>(IpcChannel.DialogOpenDocument),
    saveDocument: (request: SaveDocumentRequest) =>
      invoke<SaveDocumentResult>(IpcChannel.DialogSaveDocument, request),
    showMessage: (options: MessageOptions) =>
      invoke<void>(IpcChannel.DialogMessage, options),
  },
  document: {
    read: (filePath: string) => invoke<string>(IpcChannel.DocumentRead, { filePath }),
    write: (request: WriteDocumentRequest) =>
      invoke<void>(IpcChannel.DocumentWrite, request),
  },
  recent: {
    list: () => invoke<RecentFile[]>(IpcChannel.RecentList),
    remove: (path: string) => invoke<void>(IpcChannel.RecentRemove, path),
  },
  autosave: {
    list: () => invoke<AutosaveEntry[]>(IpcChannel.AutosaveList),
    write: (request: AutosaveWriteRequest) =>
      invoke<void>(IpcChannel.AutosaveWrite, request),
    read: (documentId: string) =>
      invoke<AutosaveReadResult | null>(IpcChannel.AutosaveRead, documentId),
    clear: (documentId: string) => invoke<void>(IpcChannel.AutosaveClear, documentId),
  },
  shell: {
    showItemInFolder: (path: string) =>
      invoke<void>(IpcChannel.ShellShowItemInFolder, path),
  },
  log: (record: LogRecord) => invoke<void>(IpcChannel.LogWrite, record),
};

contextBridge.exposeInMainWorld(DESKTOP_API_KEY, desktopApi);
