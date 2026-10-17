import type {
  Connector,
  ConnectorEndpoint,
  ConnectorRouting,
  ConnectorStyle,
  DiagramObject,
  DiagramStyle,
  TextContent,
  Transform,
} from "../../document/model";

/**
 * An object plus the array index it occupied, so a delete can be undone back
 * into its original z-position rather than being appended on top.
 */
export interface ExtractedObject {
  object: DiagramObject;
  index: number;
}

/** As `ExtractedObject`, for connectors. */
export interface ExtractedConnector {
  connector: Connector;
  index: number;
}

/**
 * The ends of a connector to replace.
 *
 * Absent keys are left alone, so rewiring one end cannot disturb the other.
 * Presence-keyed for the same reason `setContents` is: it makes "replace this
 * end" and "say nothing about this end" distinguishable.
 */
export interface ConnectorEndpoints {
  source?: ConnectorEndpoint;
  target?: ConnectorEndpoint;
}

/**
 * The connector properties the inspector edits.
 *
 * A patch rather than a whole connector, and `style` is itself partial, so
 * changing the routing cannot clobber an arrowhead the caller never mentioned.
 * Replacing the whole object would force every call site to read the connector
 * first and restate fields it has no opinion about, which is how a property
 * quietly gets reset to its default.
 */
export interface ConnectorAppearance {
  routing?: ConnectorRouting;
  style?: Partial<ConnectorStyle>;
}

/**
 * The slice of the document store that commands are allowed to touch.
 *
 * Commands depend on this rather than on the store itself so they can be
 * exercised in a node environment with no React and no DOM (TRD §22.1, and
 * NFR-MAINT-04's requirement that state transitions be predictable and
 * testable). Every method is a raw mutation: none of them records history,
 * because recording history is the command's job.
 */
export interface DocumentMutator {
  insertObjects(objects: readonly DiagramObject[]): void;
  extractObjects(ids: readonly string[]): ExtractedObject[];
  restoreObjects(extracted: readonly ExtractedObject[]): void;
  setTransforms(entries: Readonly<Record<string, Transform>>): void;
  setStyles(entries: Readonly<Record<string, DiagramStyle>>): void;
  getTransforms(ids: readonly string[]): Record<string, Transform>;
  getStyles(ids: readonly string[]): Record<string, DiagramStyle>;
  /**
   * `undefined` as a value clears the label rather than leaving it untouched —
   * the two are distinguishable because lookup is by key presence, not by value.
   */
  setContents(entries: Readonly<Record<string, TextContent | undefined>>): void;
  getContents(ids: readonly string[]): Record<string, TextContent | undefined>;
  /**
   * Ids of the active page in paint order, lowest first. Array position is
   * authoritative for stacking; `zIndex` is only a mirror the store re-stamps on
   * every write.
   */
  getObjectOrder(): string[];
  /**
   * Rearranges the active page's objects to match `order` (FR-OBJ-11).
   *
   * Objects whose id is absent from `order` are kept at the top of the stack
   * rather than dropped. A reorder that could delete an object would turn a
   * cosmetic stack change into data loss, and the safe failure mode costs
   * nothing but a wrong z position.
   */
  setObjectOrder(order: readonly string[]): void;
  /** Connectors on the active page, in document order. */
  getConnectors(): Connector[];
  insertConnectors(connectors: readonly Connector[]): void;
  extractConnectors(ids: readonly string[]): ExtractedConnector[];
  restoreConnectors(extracted: readonly ExtractedConnector[]): void;
  /**
   * Ids of connectors attached to any of `objectIds`, at either end.
   *
   * Deleting a shape has to take its connectors with it. A connector whose
   * endpoint object is gone resolves to nothing, so it renders as absent while
   * still living in the saved document — a silent orphan that accumulates across
   * edits and reappears if the shape is ever restored by hand.
   */
  connectorsTouching(objectIds: readonly string[]): string[];
  /**
   * As `setContents`, for connector labels. `undefined` as a value removes the
   * label rather than storing an empty one, so a cleared label does not leave a
   * `TextContent` shell behind in the saved document.
   */
  setConnectorLabels(
    entries: Readonly<Record<string, TextContent | undefined>>,
  ): void;
  getConnectorLabels(
    ids: readonly string[],
  ): Record<string, TextContent | undefined>;
  /**
   * Replaces whichever ends each entry names, leaving the others alone.
   *
   * This is what makes a mis-wired edge fixable in place instead of having to be
   * deleted and drawn again — and, unlike a delete, it keeps the connector's id,
   * so anything else in the document referring to it stays valid.
   */
  setConnectorEndpoints(
    entries: Readonly<Record<string, ConnectorEndpoints>>,
  ): void;
  getConnectorEndpoints(
    ids: readonly string[],
  ): Record<string, ConnectorEndpoints>;
  /**
   * Applies a partial appearance patch, merging `style` field by field.
   *
   * Merging rather than replacing is what lets the inspector own one control per
   * property: a routing dropdown that had to restate the arrowheads would reset
   * them the moment either side gained a field the other does not know about.
   */
  setConnectorAppearance(
    entries: Readonly<Record<string, ConnectorAppearance>>,
  ): void;
  /**
   * The full current appearance, so a command can capture enough to undo. Read
   * back whole even though writes are partial: an undo has to restore properties
   * the patch never mentioned too.
   */
  getConnectorAppearance(
    ids: readonly string[],
  ): Record<string, ConnectorAppearance>;
}

/**
 * A reversible edit (TRD §13.3).
 *
 * `execute` and `undo` must be exact inverses and must both be idempotent when
 * called repeatedly, because a redo replays `execute` on state that `undo`
 * already restored.
 */
export interface EditorCommand {
  readonly id: string;
  /** User-facing name, surfaced in the Edit menu and tooltips (FR-HIST-05). */
  readonly label: string;
  /** ISO 8601. */
  readonly timestamp: string;
  execute(): void;
  undo(): void;
  /**
   * Called on the *incoming* command with the current top of the undo stack.
   * Return true if the incoming edit has been folded into `previous` and should
   * therefore not be pushed as its own entry (FR-HIST-04 coalescing).
   */
  merge?(previous: EditorCommand): boolean;
}
