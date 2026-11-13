// Gigma document model.
// Deliberately mirrors Figma's node model (FRAME / GROUP / RECTANGLE / ELLIPSE /
// TEXT / VECTOR / IMAGE, relative x/y inside parent, fills & strokes arrays)
// so that conversion to and from Figma clipboard data stays lossless.

export type NodeType =
  | 'FRAME'
  | 'GROUP'
  | 'RECTANGLE'
  | 'ELLIPSE'
  | 'TEXT'
  | 'VECTOR'
  | 'IMAGE'
  /** Figma-like section: big container for organizing frames on the canvas */
  | 'SECTION'
  /** export region: invisible, exports whatever is underneath */
  | 'SLICE'
  /** task card that AI clients find and execute via MCP */
  | 'SPEC'
  /** live HTML + CSS block rendered as design */
  | 'CODE'
  /** canvas note (Figma comments, but local) */
  | 'ANNOTATION'
  /** a guideline (design system) from the shared library: a glowing dot, or an open card while it is edited */
  | 'GUIDE'

export const CONTAINER_TYPES: NodeType[] = ['FRAME', 'GROUP', 'SECTION']
export const isContainerType = (t: NodeType) => t === 'FRAME' || t === 'GROUP' || t === 'SECTION'

export interface SpecData {
  title: string
  body: string // markdown-ish task description
  status: 'TODO' | 'IN_PROGRESS' | 'DONE'
  /** what the AI (or a person) did, filled when completing */
  result?: string
  /** ids of the frames or sections this spec is wired to: the work happens there (drawn as wires on the canvas) */
  targets?: string[]
  /** ids of the frames wired into this spec as materials: components, references, the design to rebuild */
  sources?: string[]
  /** RULES = not a task with a status but standing rules for the linked frames (style guide, constraints) */
  kind?: 'TASK' | 'RULES'
}

// ---- guidelines: design systems shared by every project (kept in the app library, not in the document) ----
export interface GuideColor {
  id: string
  name: string
  /** what the colour is for: "Primary", "Background", "Text on dark"… */
  role?: string
  hex: string
}
export interface GuideFont {
  id: string
  /** "Heading", "Body", "Caption"… */
  role: string
  family: string
  weight: number
  size: number
  lineHeightPercent?: number
}
export interface GuideImage {
  id: string
  name: string
  /** the picture itself, as a data: URL (a guideline is one self-contained file) */
  dataUrl: string
}
export interface GuideSection {
  id: string
  title: string
  text: string
  images: GuideImage[]
}
export interface GuideData {
  id: string
  name: string
  description?: string
  /** hex; the dot on the canvas glows with it */
  accent?: string
  colors: GuideColor[]
  fonts: GuideFont[]
  logos: GuideImage[]
  patterns: GuideImage[]
  /** free text: tone, do / don't, spacing rules… */
  rules: string
  sections: GuideSection[]
  updatedAt: number
  formatVersion: 1
}
/** GUIDE node payload: which guideline, shown open or as a dot, and the frames / sections it is wired to */
export interface GuideRef {
  id: string
  open?: boolean
  targets?: string[]
}

export interface CodeData {
  html: string
  css: string
}

export interface RGBA {
  r: number // 0..1
  g: number
  b: number
  a: number
}

export interface GradientStop {
  position: number // 0..1
  color: RGBA
}

export type GradientPaint = {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL'
  stops: GradientStop[]
  /** linear only, CSS convention: 180 = top to bottom, 90 = left to right */
  angle?: number
  visible?: boolean
}

export type Paint =
  | { type: 'SOLID'; color: RGBA; visible?: boolean }
  | GradientPaint
  | {
      type: 'IMAGE'
      imageHash: string // SHA-1 hex of the image bytes (same scheme as Figma's image hash)
      scaleMode: 'FILL' | 'FIT' | 'STRETCH'
      visible?: boolean
      /** set when pasted from Figma: lets Gigma fetch missing image bytes via the Figma API */
      figmaFileKey?: string
    }

export interface Stroke {
  color: RGBA
  weight: number
  align?: 'INSIDE' | 'CENTER' | 'OUTSIDE'
  visible?: boolean
}

/** Layer effects, same set and semantics as Figma */
export type Effect =
  | {
      type: 'DROP_SHADOW' | 'INNER_SHADOW'
      color: RGBA
      offset: { x: number; y: number }
      radius: number // blur
      spread: number
      visible?: boolean
    }
  | { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number; visible?: boolean }

export type EffectType = Effect['type']

export function defaultEffect(type: EffectType): Effect {
  if (type === 'DROP_SHADOW' || type === 'INNER_SHADOW')
    return { type, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 4, spread: 0, visible: true }
  return { type, radius: 4, visible: true }
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  fontWeight: number
  italic?: boolean
  /** line height: percent wins over px; neither = Auto */
  lineHeight?: number // px
  lineHeightPercent?: number
  /** letter spacing: percent of font size wins over px (Figma shows %) */
  letterSpacing?: number // px
  letterSpacingPercent?: number
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'
  verticalAlign?: 'TOP' | 'CENTER' | 'BOTTOM'
  decoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE'
  paragraphSpacing?: number
  listStyle?: 'NONE' | 'BULLET' | 'NUMBER'
  /** fixed-size text: cut overflowing lines and end with "…" */
  truncate?: boolean
  /** Figma "Vertical trim": STANDARD line boxes or tight cap-height-to-baseline box */
  verticalTrim?: 'STANDARD' | 'CAP_HEIGHT'
  /** Figma "Wrap style": AUTO (greedy) or BALANCED (even line lengths) */
  wrapStyle?: 'AUTO' | 'BALANCED'
}

export const BLEND_MODES = [
  'NORMAL',
  'DARKEN',
  'MULTIPLY',
  'COLOR_BURN',
  'LIGHTEN',
  'SCREEN',
  'COLOR_DODGE',
  'OVERLAY',
  'SOFT_LIGHT',
  'HARD_LIGHT',
  'DIFFERENCE',
  'EXCLUSION',
  'HUE',
  'SATURATION',
  'COLOR',
  'LUMINOSITY'
] as const
export type BlendMode = (typeof BLEND_MODES)[number]
/** canvas globalCompositeOperation / CSS mix-blend-mode name */
export const blendCss = (m: BlendMode | undefined): string => (!m || m === 'NORMAL' ? 'source-over' : m.toLowerCase().replace(/_/g, '-'))

/** MIN = left / top, MAX = right / bottom, STRETCH = both sides, SCALE = proportional */
export type Constraint = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE'

export type BooleanOperation ='UNION' | 'SUBTRACT' | 'INTERSECT' | 'EXCLUDE'

export interface BaseNode {
  id: string
  type: NodeType
  name: string
  parentId: string | null // null = top level on the page
  pageId: string
  /** fractional index string for stable ordering among siblings (lexicographic) */
  order: string
  x: number // relative to parent
  y: number
  width: number
  height: number
  /** degrees around the node's center, Figma convention (counter-clockwise positive) */
  rotation?: number
  opacity: number
  visible: boolean
  locked: boolean
  fills: Paint[]
  strokes: Stroke[]
  effects?: Effect[]
  cornerRadius?: number
  /** independent corners [top-left, top-right, bottom-right, bottom-left]; overrides cornerRadius */
  cornerRadii?: [number, number, number, number]
  /** mirror around the node's center */
  flipX?: boolean
  flipY?: boolean
  /** keep W/H ratio when editing dimensions in the inspector */
  constrainProportions?: boolean
  /** how the layer follows its parent frame when that frame is resized (Figma constraints); default MIN / MIN */
  constraints?: { horizontal: Constraint; vertical: Constraint }
  /** linked styles of the document (DocMeta.colorStyles / textStyles): the layer follows the style until it is edited by hand */
  fillStyleId?: string
  strokeStyleId?: string
  textStyleId?: string
  /** FRAME: a component set, the frame that holds the variants of one component */
  isComponentSet?: boolean
  // ---- components (same idea as Figma: one main component, many linked instances) ----
  /** FRAME: this is a main component */
  isComponent?: boolean
  /** FRAME: this is an instance of the main component with that id */
  componentId?: string
  /** layer inside an instance: id of the layer of the main component it mirrors */
  sourceId?: string
  /** instance layers: properties changed on the instance, kept when the main component changes */
  overrides?: string[]
  /** GROUP only: a boolean group, drawn as one shape computed from its children (bottom child first) */
  booleanOperation?: BooleanOperation
  /** how the layer mixes with what is below it (Figma blend modes); undefined = normal */
  blendMode?: BlendMode
  // ---- auto layout (frames), same fields and semantics as Figma ----
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  itemSpacing?: number
  /** WRAP: items that do not fit continue on the next line (needs a fixed size along the layout direction) */
  layoutWrap?: 'NO_WRAP' | 'WRAP'
  /** gap between the lines of a wrapping layout */
  counterAxisSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX'
  /** AUTO = hug contents along the layout direction */
  primaryAxisSizingMode?: 'FIXED' | 'AUTO'
  counterAxisSizingMode?: 'FIXED' | 'AUTO'
  // ---- child of an auto layout frame ----
  /** 1 = fill container along the layout direction */
  layoutGrow?: number
  /** STRETCH = fill container across the layout direction */
  layoutAlign?: 'INHERIT' | 'STRETCH'
  /** ABSOLUTE = ignore auto layout, keep own x / y */
  layoutPositioning?: 'AUTO' | 'ABSOLUTE'
  clipsContent?: boolean // frames only
  /** like Figma "Use as mask": this layer's shape clips the siblings above it (and is not drawn) */
  isMask?: boolean
  /** VECTOR lines/paths: arrowhead at the end point (Arrow tool) */
  arrowEnd?: boolean
  strokeCap?: 'NONE' | 'ROUND' | 'SQUARE'
  /** SPEC node payload */
  spec?: SpecData
  /** CODE node payload */
  code?: CodeData
  /** GUIDE node payload */
  guide?: GuideRef
  /** ANNOTATION: resolved notes are hidden from the canvas */
  resolved?: boolean
  // TEXT
  characters?: string
  textStyle?: TextStyle
  /** like Figma: WIDTH_AND_HEIGHT = auto width, HEIGHT = fixed width / auto height */
  textAutoResize?: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE'
  // VECTOR: SVG path data in node-local coordinates, plus original viewBox size
  path?: string
  pathBox?: { w: number; h: number }
  fillRule?: 'nonzero' | 'evenodd'
}

export type GNode = BaseNode

export interface Page {
  id: string
  name: string
  order: string
  background: RGBA
}

export interface DocMeta {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  formatVersion: number
  /** saved color styles of this document (the "styles" button in Fill / Stroke) */
  colorStyles?: ColorStyle[]
  /** saved text styles of this document */
  textStyles?: TextStyleDef[]
  /** copies of the guidelines used in this document, so the file still shows them on another computer */
  guides?: Record<string, GuideData>
}

export interface TextStyleDef {
  id: string
  name: string
  style: TextStyle
}

export interface ColorStyle {
  id: string
  name: string
  color: RGBA
}

export interface DocSnapshot {
  meta: DocMeta
  pages: Page[]
  nodes: GNode[]
}

/** Incremental change set sent from the editor to storage. */
export interface DocChanges {
  upsertNodes?: GNode[]
  deleteNodes?: string[]
  upsertPages?: Page[]
  deletePages?: string[]
  meta?: Partial<DocMeta>
}

export const FORMAT_VERSION = 1

/** Default canvas (page) background: #404040 */
export const DEFAULT_PAGE_BG: RGBA = { r: 64 / 255, g: 64 / 255, b: 64 / 255, a: 1 }

export const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ r, g, b, a })

export function hexToRgba(hex: string): RGBA {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a }
}

export function rgbaToHex(c: RGBA, withAlpha = false): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return '#' + to(c.r) + to(c.g) + to(c.b) + (withAlpha && c.a < 1 ? to(c.a) : '')
}

export function rgbaToCss(c: RGBA, extraAlpha = 1): string {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${+(c.a * extraAlpha).toFixed(4)})`
}
