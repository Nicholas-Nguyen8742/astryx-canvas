/**
 * Document model for the `.astrx` format (TRD §12.1).
 *
 * This is the serialisation contract: everything here must round-trip through
 * JSON unchanged. Types the TRD references but does not define (Point,
 * BoundingBox, GridSettings, TextStyle, ShadowStyle, GradientStyle, PortDefinition)
 * are pinned down here so the schema is closed rather than implicitly `any`.
 */

export const SCHEMA_VERSION = 1;
export const APP_ID = "astryx-architecture-canvas";
export const DOCUMENT_MIME_TYPE = "application/x-astryx-diagram";

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type ThemeMode = "light" | "dark" | "system";

export interface DocumentMeta {
  title: string;
  description?: string;
  author?: string;
  tags?: string[];
  astryxTheme?: ThemeMode;
}

export type GridType = "dot" | "line";

export interface GridSettings {
  enabled: boolean;
  size: number;
  type: GridType;
}

/** TRD §14.3. */
export interface SnapSettings {
  enabled: boolean;
  gridSize: number;
  objectTolerance: number;
  smartGuides: boolean;
}

export interface ShadowStyle {
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string;
}

export interface GradientStop {
  offset: number;
  color: string;
}

export interface GradientStyle {
  type: "linear" | "radial";
  angle: number;
  stops: GradientStop[];
}

export type TextAlign = "left" | "center" | "right";

export interface TextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: TextAlign;
  color?: string;
}

export interface TextContent {
  value: string;
  style?: TextStyle;
}

/**
 * Colours SHOULD reference Astryx token names with a resolved hex fallback
 * (TRD §12.3 rule 3), so a token reference and its computed value travel together.
 */
export interface ColorValue {
  token?: string;
  hex: string;
}

export interface DiagramStyle {
  fill?: ColorValue;
  stroke?: ColorValue;
  strokeWidth?: number;
  opacity?: number;
  cornerRadius?: number;
  shadow?: ShadowStyle;
  gradient?: GradientStyle;
  dashArray?: number[];
  text?: TextStyle;
}

export interface Transform {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  flipX?: boolean;
  flipY?: boolean;
}

export type ObjectType =
  | "rectangle"
  | "roundedRectangle"
  | "ellipse"
  | "circle"
  | "diamond"
  | "triangle"
  | "line"
  | "arrow"
  | "polyline"
  | "path"
  | "text"
  | "image"
  | "group"
  | "stencil";

/** Normalised attachment point, in object-relative 0..1 coordinates (TRD §11.3). */
export interface PortDefinition {
  id: string;
  x: number;
  y: number;
}

export interface PortInstance extends PortDefinition {
  /** Set once a connector is bound, so hover feedback can be suppressed. */
  occupiedBy?: string[];
}

export type SemanticType =
  | "client"
  | "service"
  | "database"
  | "queue"
  | "gateway"
  | "loadBalancer"
  | "cache"
  | "worker"
  | "function"
  | "storage"
  | "externalSystem"
  | "networkBoundary"
  | "region"
  | "subnet"
  | "monitoring"
  | "generic";

export interface DiagramObject {
  id: string;
  type: ObjectType;
  name?: string;
  parentId?: string;
  zIndex: number;
  visible: boolean;
  locked: boolean;
  transform: Transform;
  style: DiagramStyle;
  content?: TextContent;
  stencilId?: string;
  semanticType?: SemanticType;
  ports?: PortInstance[];
  /** Preserved verbatim on load so unknown fields survive a round-trip (§12.3 rule 6). */
  metadata?: Record<string, unknown>;
}

export type ArrowType = "none" | "triangle" | "diamond" | "circle" | "open";

export interface ConnectorStyle {
  stroke: ColorValue;
  strokeWidth: number;
  opacity: number;
  dashArray?: number[];
  startArrow?: ArrowType;
  endArrow?: ArrowType;
}

export interface ConnectorEndpoint {
  objectId: string;
  portId?: string;
  fallbackPoint?: Point;
}

export type ConnectorRouting = "straight" | "orthogonal" | "curved";

export interface Connector {
  id: string;
  source: ConnectorEndpoint;
  target: ConnectorEndpoint;
  routing: ConnectorRouting;
  style: ConnectorStyle;
  label?: TextContent;
  points?: Point[];
  zIndex: number;
  visible: boolean;
  locked: boolean;
}

export interface Page {
  id: string;
  name: string;
  viewport: Viewport;
  objects: DiagramObject[];
  connectors: Connector[];
  bounds?: BoundingBox;
}

export interface Asset {
  id: string;
  type: "image" | "font" | "icon";
  mimeType: string;
  /** Base64 data URL for the MVP; a ZIP container is deferred (§12.3 rule 5). */
  data: string;
  fileName?: string;
  width?: number;
  height?: number;
}

export interface DocumentSettings {
  defaultGrid: GridSettings;
  defaultBackground: ColorValue;
  snapping: SnapSettings;
  connectorDefaults: ConnectorStyle;
  textDefaults: TextStyle;
}

export interface DiagramDocument {
  schemaVersion: number;
  appId: string;
  documentId: string;
  /** ISO 8601 (§12.3 rule 2). */
  createdAt: string;
  updatedAt: string;
  meta: DocumentMeta;
  pages: Page[];
  assets: Asset[];
  settings: DocumentSettings;
}
