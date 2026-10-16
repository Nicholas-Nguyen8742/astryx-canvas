import {resolve} from 'node:path';

/**
 * Path allowlist for IPC (NFR-SEC-06).
 *
 * The renderer can only ever read or write a path that either came back from a
 * native dialog the user just answered, was restored from our own recent/autosave
 * stores, or sits inside a directory we own. A path invented by compromised
 * renderer code is rejected before it reaches the filesystem.
 */

const grantedFiles = new Set<string>();
const grantedRoots = new Set<string>();

function normalize(candidate: string): string {
  const resolved = resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const SEPARATOR = process.platform === 'win32' ? '\\' : '/';

export function grantFile(path: string): void {
  grantedFiles.add(normalize(path));
}

export function grantRoot(dir: string): void {
  grantedRoots.add(normalize(dir));
}

export function revokeFile(path: string): void {
  grantedFiles.delete(normalize(path));
}

export function isPathGranted(path: string): boolean {
  const candidate = normalize(path);
  if (grantedFiles.has(candidate)) {
    return true;
  }
  for (const root of grantedRoots) {
    if (candidate === root || candidate.startsWith(`${root}${SEPARATOR}`)) {
      return true;
    }
  }
  return false;
}
