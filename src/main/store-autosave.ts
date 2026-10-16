import { mkdir, readdir, readFile, unlink } from "node:fs/promises";

import { appPaths } from "./paths";
import { atomicWriteText } from "./atomic-write";
import type { AutosaveEntry, AutosaveReadResult } from "../shared/ipc";

/**
 * Document ids are supplied by the renderer and become filenames, so they are
 * the one place a path-traversal string could escape the autosave directory
 * (NFR-SEC-06). Only a conservative id shape is accepted; anything else is a
 * caller bug and is rejected rather than sanitised into something surprising.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeDocumentId(documentId: string): boolean {
  return SAFE_ID.test(documentId);
}

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: string }).code === "ENOENT"
  );
}

async function asEntry(documentId: string): Promise<AutosaveEntry | null> {
  try {
    const raw = await readFile(appPaths.autosaveMeta(documentId), "utf8");
    const parsed = JSON.parse(raw) as Partial<AutosaveEntry>;
    if (typeof parsed.lastSavedAt !== "string") return null;
    return {
      documentId,
      lastSavedAt: parsed.lastSavedAt,
      originalPath:
        typeof parsed.originalPath === "string" ? parsed.originalPath : null,
    };
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
}

export async function writeAutosave(
  documentId: string,
  contents: string,
  originalPath: string | null,
): Promise<void> {
  if (!isSafeDocumentId(documentId)) {
    throw new Error(`Refusing autosave for unsafe document id: ${documentId}`);
  }

  await mkdir(appPaths.autosaveDir, { recursive: true });

  const entry: AutosaveEntry = {
    documentId,
    lastSavedAt: new Date().toISOString(),
    originalPath,
  };

  // Document first, metadata second: a crash between the two leaves recoverable
  // content with no pointer, which listAutosave still surfaces by filename.
  await atomicWriteText(appPaths.autosaveFile(documentId), contents);
  await atomicWriteText(
    appPaths.autosaveMeta(documentId),
    JSON.stringify(entry, null, 2),
  );
}

export async function readAutosave(
  documentId: string,
): Promise<AutosaveReadResult | null> {
  if (!isSafeDocumentId(documentId)) return null;

  let contents: string;
  try {
    contents = await readFile(appPaths.autosaveFile(documentId), "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }

  const entry = (await asEntry(documentId)) ?? {
    documentId,
    lastSavedAt: new Date(0).toISOString(),
    originalPath: null,
  };

  return { entry, contents };
}

export async function clearAutosave(documentId: string): Promise<void> {
  if (!isSafeDocumentId(documentId)) return;
  for (const target of [
    appPaths.autosaveFile(documentId),
    appPaths.autosaveMeta(documentId),
  ]) {
    try {
      await unlink(target);
    } catch (cause) {
      if (!isMissingFile(cause)) throw cause;
    }
  }
}

export async function listAutosave(): Promise<AutosaveEntry[]> {
  let names: string[];
  try {
    names = await readdir(appPaths.autosaveDir);
  } catch (cause) {
    if (isMissingFile(cause)) return [];
    throw cause;
  }

  const ids = names
    .filter((name) => name.endsWith(".astrx"))
    .map((name) => name.slice(0, -".astrx".length))
    .filter(isSafeDocumentId);

  const entries: AutosaveEntry[] = [];
  for (const id of ids) {
    const entry = await asEntry(id);
    if (entry) {
      entries.push(entry);
    } else {
      // Content exists but its sidecar does not; still offer recovery.
      entries.push({
        documentId: id,
        lastSavedAt: new Date(0).toISOString(),
        originalPath: null,
      });
    }
  }
  entries.sort((a, b) => (a.lastSavedAt < b.lastSavedAt ? 1 : -1));
  return entries;
}
