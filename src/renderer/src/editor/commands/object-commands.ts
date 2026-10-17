import type {
  DiagramObject,
  DiagramStyle,
  TextContent,
  Transform,
} from "../../document/model";
import type { DocumentMutator, EditorCommand, ExtractedObject } from "./index";
import { reorderIds, zOrderLabel, type ZOrderMove } from "../z-order";

let sequence = 0;

function nextCommandId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence.toString(36)}`;
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

function describeCount(count: number, singular: string): string {
  return count === 1 ? singular : `${count} ${singular}s`;
}

export class CreateObjectsCommand implements EditorCommand {
  readonly id = nextCommandId("create");
  readonly label: string;
  readonly timestamp = new Date().toISOString();

  constructor(
    private readonly mutator: DocumentMutator,
    private readonly objects: readonly DiagramObject[],
  ) {
    this.label = `Create ${describeCount(objects.length, "object")}`;
  }

  execute(): void {
    this.mutator.insertObjects(this.objects);
  }

  undo(): void {
    this.mutator.extractObjects(this.objects.map((object) => object.id));
  }
}

export class DeleteObjectsCommand implements EditorCommand {
  readonly id = nextCommandId("delete");
  readonly label: string;
  readonly timestamp = new Date().toISOString();
  private extracted: ExtractedObject[] = [];

  constructor(
    private readonly mutator: DocumentMutator,
    private readonly ids: readonly string[],
  ) {
    this.label = `Delete ${describeCount(ids.length, "object")}`;
  }

  execute(): void {
    this.extracted = this.mutator.extractObjects(this.ids);
  }

  undo(): void {
    this.mutator.restoreObjects(this.extracted);
  }
}

/**
 * Shared machinery for any command whose net effect is a set of transform
 * replacements. Move and resize differ only in their user-facing label, so the
 * coalescing rule lives here once rather than twice.
 */
abstract class TransformObjectsCommand implements EditorCommand {
  abstract readonly id: string;
  abstract readonly label: string;
  readonly timestamp = new Date().toISOString();

  constructor(
    protected readonly mutator: DocumentMutator,
    protected readonly ids: readonly string[],
    private readonly from: Readonly<Record<string, Transform>>,
    private to: Readonly<Record<string, Transform>>,
  ) {}

  execute(): void {
    this.mutator.setTransforms(this.to);
  }

  undo(): void {
    this.mutator.setTransforms(this.from);
  }

  /**
   * Folds a later transform of the same objects into the earlier one. The
   * earlier command keeps its original `from`, so one undo still returns to
   * where the gesture started rather than one keystroke back.
   */
  protected absorb(previous: TransformObjectsCommand): boolean {
    if (!sameIdSet(previous.ids, this.ids)) return false;
    previous.to = this.to;
    return true;
  }
}

export class MoveObjectsCommand extends TransformObjectsCommand {
  readonly id = nextCommandId("move");
  readonly label: string;

  constructor(
    mutator: DocumentMutator,
    ids: readonly string[],
    from: Readonly<Record<string, Transform>>,
    to: Readonly<Record<string, Transform>>,
  ) {
    super(mutator, ids, from, to);
    this.label = `Move ${describeCount(ids.length, "object")}`;
  }

  merge(previous: EditorCommand): boolean {
    return previous instanceof MoveObjectsCommand
      ? this.absorb(previous)
      : false;
  }
}

export class ResizeObjectCommand extends TransformObjectsCommand {
  readonly id = nextCommandId("resize");
  readonly label = "Resize";

  merge(previous: EditorCommand): boolean {
    return previous instanceof ResizeObjectCommand
      ? this.absorb(previous)
      : false;
  }
}

export class UpdateStyleCommand implements EditorCommand {
  readonly id = nextCommandId("style");
  readonly label = "Change style";
  readonly timestamp = new Date().toISOString();

  constructor(
    private readonly mutator: DocumentMutator,
    private readonly ids: readonly string[],
    private readonly from: Readonly<Record<string, DiagramStyle>>,
    private to: Readonly<Record<string, DiagramStyle>>,
  ) {}

  execute(): void {
    this.mutator.setStyles(this.to);
  }

  undo(): void {
    this.mutator.setStyles(this.from);
  }

  merge(previous: EditorCommand): boolean {
    if (!(previous instanceof UpdateStyleCommand)) return false;
    if (!sameIdSet(previous.ids, this.ids)) return false;
    previous.to = this.to;
    return true;
  }
}

/**
 * Inline label edits (FR-TEXT-02).
 *
 * Coalescing matters more here than for any other command: without `merge`,
 * typing a twelve-character label would push twelve undo entries and burn through
 * the history limit inside a single field (FR-HIST-04). With it, one edit session
 * is one undo step that returns to whatever the label was before typing began.
 */
export class UpdateContentCommand implements EditorCommand {
  readonly id = nextCommandId("content");
  readonly label = "Edit text";
  readonly timestamp = new Date().toISOString();

  constructor(
    private readonly mutator: DocumentMutator,
    private readonly ids: readonly string[],
    private readonly from: Readonly<Record<string, TextContent | undefined>>,
    private to: Readonly<Record<string, TextContent | undefined>>,
  ) {}

  execute(): void {
    this.mutator.setContents(this.to);
  }

  undo(): void {
    this.mutator.setContents(this.from);
  }

  merge(previous: EditorCommand): boolean {
    if (!(previous instanceof UpdateContentCommand)) return false;
    if (!sameIdSet(previous.ids, this.ids)) return false;
    previous.to = this.to;
    return true;
  }
}

/**
 * Z-order changes (FR-OBJ-11).
 *
 * Captures the whole order on both sides rather than a delta. A block "bring
 * forward" moves several objects past several others at once, and deriving the
 * inverse from a delta is exactly the arithmetic that silently corrupts a
 * document on redo; two id lists cannot be subtly wrong.
 *
 * The order is read in the constructor, so this command is for immediate
 * execution — unlike a drag, there is no gesture whose pre-state has to be
 * snapshotted before further edits land.
 *
 * Deliberately never coalesces. Each press is a distinct step the user may want
 * to walk back individually, and there is no continuous gesture to fold.
 */
export class ReorderObjectsCommand implements EditorCommand {
  readonly id = nextCommandId("z-order");
  readonly label: string;
  readonly timestamp = new Date().toISOString();

  private readonly before: string[];
  private readonly after: string[] | null;

  constructor(
    private readonly mutator: DocumentMutator,
    ids: readonly string[],
    move: ZOrderMove,
  ) {
    this.label = zOrderLabel(move);
    this.before = mutator.getObjectOrder();
    this.after = reorderIds(this.before, ids, move);
  }

  /**
   * True when every selected object is already as far as it can go. Callers must
   * skip these: recording a no-op would fill the history with entries that undo
   * nothing while evicting real work from the cap (FR-HIST-02).
   */
  get isNoOp(): boolean {
    return this.after === null;
  }

  execute(): void {
    if (this.after) this.mutator.setObjectOrder(this.after);
  }

  undo(): void {
    this.mutator.setObjectOrder(this.before);
  }
}
