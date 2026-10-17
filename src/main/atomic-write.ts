import {
  copyFile,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: string }).code === "ENOENT"
  );
}

async function discardQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }
}

/**
 * Crash-resistant write (FR-FILE-04, NFR-REL-02/03, TRD §20.3).
 *
 * Contents land in a sibling temp file, are flushed to disk, and only then rename
 * over the target. A rename within a directory is atomic on all three target
 * platforms, so an interrupted write leaves either the old file or the new one —
 * never a truncated mixture. Shared by documents and binary exports so the two
 * cannot drift into different durability guarantees.
 */
async function writeThroughTemporary(
  target: string,
  write: (handle: FileHandle) => Promise<void>,
  options: { backup?: boolean },
): Promise<void> {
  const temporary = `${target}.tmp`;

  const handle = await open(temporary, "w");
  try {
    await write(handle);
    await handle.sync();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await discardQuietly(temporary);
    throw cause;
  }
  await handle.close();

  if (options.backup) {
    // Preserve the pre-existing version before it is replaced. A first write has
    // none, which is expected rather than an error.
    try {
      await copyFile(target, `${target}.bak`);
    } catch (cause) {
      if (!isMissingFile(cause)) {
        await discardQuietly(temporary);
        throw cause;
      }
    }
  }

  try {
    await rename(temporary, target);
  } catch (cause) {
    await discardQuietly(temporary);
    throw cause;
  }
}

export async function atomicWriteText(
  target: string,
  contents: string,
  options: { backup?: boolean } = {},
): Promise<void> {
  await writeThroughTemporary(
    target,
    (handle) => handle.writeFile(contents, "utf8"),
    options,
  );
}

/**
 * Binary variant for exports. No backup by default: an export is a derived
 * artifact, and silently keeping a `.bak` of every PNG a user overwrites would
 * litter their folders.
 */
export async function atomicWriteBuffer(
  target: string,
  data: Uint8Array,
): Promise<void> {
  await writeThroughTemporary(target, (handle) => handle.writeFile(data), {});
}
