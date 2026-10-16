import { SCHEMA_VERSION, type DiagramDocument } from "./model";

/**
 * Load-time validation (NFR-REL-04, FR-FILE-08).
 *
 * Deliberately hand-rolled and structural rather than schema-library based: it
 * has to run before anything is rendered, it must produce a message a user can
 * act on (NFR-USE-04), and it must distinguish "not ours", "corrupt", "too new"
 * and "too old" because each needs a different recovery offer (TRD §20.1).
 */

export type DocumentProblemKind =
  | "not-json"
  | "not-a-document"
  | "schema-too-new"
  | "schema-too-old"
  | "malformed";

export interface DocumentProblem {
  kind: DocumentProblemKind;
  message: string;
}

export type DocumentParseResult =
  | { ok: true; document: DiagramDocument }
  | { ok: false; problem: DocumentProblem };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe(value: unknown): string {
  return typeof value === "object" && value !== null ? "object" : typeof value;
}

export function parseDocument(raw: string): DocumentParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      problem: {
        kind: "not-json",
        message: `This file is not valid JSON (${
          cause instanceof Error ? cause.message : "parse error"
        }). It may be corrupt or may not be an Astryx diagram.`,
      },
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      problem: {
        kind: "not-a-document",
        message: "Expected a diagram object at the top level of the file.",
      },
    };
  }

  const version = parsed.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      ok: false,
      problem: {
        kind: "not-a-document",
        message: `Missing or invalid "schemaVersion" (found ${describe(version)}).`,
      },
    };
  }

  // A newer major schema may use fields we would silently drop on re-save.
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      problem: {
        kind: "schema-too-new",
        message: `This diagram was written by a newer version of Astryx Architecture Canvas (schema v${version}; this build understands v${SCHEMA_VERSION}). Update the app to open it.`,
      },
    };
  }
  if (version < 1) {
    return {
      ok: false,
      problem: {
        kind: "schema-too-old",
        message: `This diagram uses schema v${version}, which predates the first supported version (v1).`,
      },
    };
  }

  if (typeof parsed.documentId !== "string" || parsed.documentId.length === 0) {
    return {
      ok: false,
      problem: { kind: "malformed", message: 'Missing or invalid "documentId".' },
    };
  }

  if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    return {
      ok: false,
      problem: {
        kind: "malformed",
        message: 'A diagram must contain a non-empty "pages" array.',
      },
    };
  }

  for (const [index, page] of parsed.pages.entries()) {
    if (!isRecord(page)) {
      return {
        ok: false,
        problem: { kind: "malformed", message: `Page ${index + 1} is not an object.` },
      };
    }
    if (typeof page.id !== "string") {
      return {
        ok: false,
        problem: { kind: "malformed", message: `Page ${index + 1} has no string "id".` },
      };
    }
    // An absent collection is normalised to empty rather than rejected: it is
    // unambiguous, and refusing to open an otherwise sound file is worse.
    if (page.objects === undefined) page.objects = [];
    if (page.connectors === undefined) page.connectors = [];
    if (!Array.isArray(page.objects) || !Array.isArray(page.connectors)) {
      return {
        ok: false,
        problem: {
          kind: "malformed",
          message: `Page ${index + 1} has non-array "objects" or "connectors".`,
        },
      };
    }
  }

  if (!isRecord(parsed.meta) || typeof parsed.meta.title !== "string") {
    return {
      ok: false,
      problem: { kind: "malformed", message: 'Missing "meta.title".' },
    };
  }

  // The structural checks above are what makes the cast safe; per-object shape is
  // re-checked as objects are mounted onto the canvas.
  return { ok: true, document: parsed as unknown as DiagramDocument };
}
