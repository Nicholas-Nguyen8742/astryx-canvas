import { copyFile, open, rename, unlink } from "node:fs/promises";

function isMissingFile(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: string }).code === "ENOENT"
  );
}

/**
 * Crash-resistant write (FR-FILE-04, NFR-REL-02, TRD §20.3).
 *
 * Contents land in a sibling temp file, are flushed to disk, and only then rename
 * over the target. A rename within a directory is atomic on all three target
 * platforms, so an interrupted save leaves either the old document or the new one
 * — never a truncated mixture.
 */
export async function atomicWriteText(
  target: string,
  contents: string,
  options: { backup?: boolean } = {},
): Promise<void> {
  const temporary = `${target}.tmp`;

  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
  await handle.close();

  if (options.backup) {
    // Only the pre-existing version is worth keeping; a first save has none.
    try {
      await copyFile(target, `${target}.bak`);
    } catch (cause) {
      if (!isMissingFile(cause)) {
        throw cause;
      }
    }
  }

  try {
    await rename(temporary, target);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}
