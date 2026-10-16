import { readFile } from "node:fs/promises";

import { appPaths } from "./paths";
import { atomicWriteText } from "./atomic-write";
import type { RecentFile } from "../shared/ipc";

const MAX_RECENT = 12;

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: string }).code === "ENOENT"
  );
}

function asRecentFile(value: unknown): RecentFile | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<RecentFile>;
  if (typeof candidate.path !== "string" || candidate.path.length === 0)
    return null;
  if (typeof candidate.title !== "string") return null;
  if (typeof candidate.lastOpened !== "string") return null;
  return {
    path: candidate.path,
    title: candidate.title,
    lastOpened: candidate.lastOpened,
  };
}

/**
 * A malformed recent list is an inconvenience, not an incident: the app must
 * still start (NFR-REL-05 applies to documents, and the same spirit holds here).
 * Anything unparseable is treated as empty and rewritten on the next save.
 */
export async function listRecent(): Promise<RecentFile[]> {
  let raw: string;
  try {
    raw = await readFile(appPaths.recentStore, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return [];
    // A real I/O failure (permissions, disk) must surface, not masquerade as an
    // empty list; the IPC layer turns it into an actionable error.
    throw cause;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: RecentFile[] = [];
  for (const item of parsed) {
    const entry = asRecentFile(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function addRecent(entry: RecentFile): Promise<void> {
  const existing = await listRecent();
  const deduped = existing.filter((item) => item.path !== entry.path);
  const next = [entry, ...deduped].slice(0, MAX_RECENT);
  await atomicWriteText(appPaths.recentStore, JSON.stringify(next, null, 2));
}

export async function removeRecent(path: string): Promise<void> {
  const existing = await listRecent();
  const next = existing.filter((item) => item.path !== path);
  await atomicWriteText(appPaths.recentStore, JSON.stringify(next, null, 2));
}
