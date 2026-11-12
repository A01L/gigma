import type { ReactElement } from 'react'

const S = (d: ReactElement | ReactElement[], size = 16) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
)

export const Icons = {
  // plump, rounded pointer: a filled triangle whose thick round-joined stroke softens every corner
  // Figma-like outlined pointer with soft rounded corners
  move: S(<path d="M3.6 2.9l9.3 3.5-4 1.6-1.6 4z" strokeWidth="1.3" strokeLinejoin="round" />, 18),
  frame: S(<path d="M5.2 2.5v11M10.8 2.5v11M2.5 5.2h11M2.5 10.8h11" />, 18),
  rect: S(<rect x="2.5" y="2.5" width="11" height="11" rx="1.2" />, 18),
  ellipse: S(<circle cx="8" cy="8" r="5.5" />, 18),
  text: S(<path d="M3.5 5V3.5h9V5M8 3.5v9M6.3 12.5h3.4" />, 18),
  hand: S(<path d="M5 8V4a1 1 0 012 0v3V3a1 1 0 012 0v4-3a1 1 0 012 0v5c0 3-1.5 5-4 5-2 0-3-1-4.5-3L3 9a1 1 0 011.6-1.1L5 8.5" />, 18),
  image: S([<rect key="a" x="2" y="3" width="12" height="10" rx="1" />, <circle key="b" cx="6" cy="6.5" r="1.2" />, <path key="c" d="M2.5 12l4-4 3 3 1.5-1.5 2.5 2.5" />], 18),
  ai: S([<path key="a" d="M8 1.5l1.4 3.6L13 6.5 9.4 7.9 8 11.5 6.6 7.9 3 6.5l3.6-1.4z" />, <path key="b" d="M12.5 11l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" />], 18),
  sidebarL: S([<rect key="a" x="2" y="2.5" width="12" height="11" rx="1.5" />, <path key="b" d="M6 2.5v11" />]),
  sidebarR: S([<rect key="a" x="2" y="2.5" width="12" height="11" rx="1.5" />, <path key="b" d="M10 2.5v11" />]),
  plus: S(<path d="M8 3v10M3 8h10" />),
  home: S(<path d="M2.5 7.5L8 3l5.5 4.5V13a.5.5 0 01-.5.5H9.5v-3h-3v3H3a.5.5 0 01-.5-.5z" />),
  chevR: S(<path d="M6 4l4 4-4 4" />, 12),
  chevD: S(<path d="M4 6l4 4 4-4" />, 12),
  eye: S([<path key="a" d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />, <circle key="b" cx="8" cy="8" r="2" />], 14),
  eyeOff: S([<path key="a" d="M2 2l12 12M6.5 4C7 3.7 7.5 3.5 8 3.5 12 3.5 14.5 8 14.5 8s-.7 1.3-2 2.6M4 5.5C2.5 6.7 1.5 8 1.5 8S4 12.5 8 12.5c1 0 1.9-.3 2.7-.7" />], 14),
  lock: S([<rect key="a" x="3.5" y="7" width="9" height="6.5" rx="1" />, <path key="b" d="M5.5 7V5a2.5 2.5 0 015 0v2" />], 14),
  unlock: S([<rect key="a" x="3.5" y="7" width="9" height="6.5" rx="1" />, <path key="b" d="M5.5 7V5a2.5 2.5 0 014.8-1" />], 14),
  trash: S(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" />, 14),
  export: S(<path d="M8 2v8M5 5l3-3 3 3M3 10v3.5h10V10" />, 14),
  group: S(<rect x="2.5" y="2.5" width="11" height="11" rx="1" strokeDasharray="2 2" />, 14),
  vector: S(<path d="M3 12C5 3 11 13 13 4" />, 14),
  alignL: S(<path d="M2.5 2v12M5 5h8M5 11h5" />),
  alignCH: S(<path d="M8 2v12M4 5h8M5.5 11h5" />),
  alignR: S(<path d="M13.5 2v12M3 5h8M6 11h5" />),
  alignT: S(<path d="M2 2.5h12M5 5v8M11 5v5" />),
  alignCV: S(<path d="M2 8h12M5 4v8M11 5.5v5" />),
  alignB: S(<path d="M2 13.5h12M5 3v8M11 6v5" />),
  autoW: S([<path key="a" d="M2 8h12M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5" />]),
  autoH: S([<path key="a" d="M8 2v12M5.5 4.5L8 2l2.5 2.5M5.5 11.5L8 14l2.5-2.5" />]),
  fixedSize: S([<rect key="a" x="3" y="3" width="10" height="10" rx="1.5" />, <path key="b" d="M6 8h4" />]),
  scale: S([<rect key="a" x="2.5" y="6.5" width="7" height="7" rx="1" />, <path key="b" d="M8 2.5h5.5V8M13.5 2.5L8 8" />], 18),
  section: S([<rect key="a" x="2" y="2.5" width="12" height="11" rx="1.5" />, <rect key="b" x="3.8" y="4.2" width="5" height="2.2" rx="0.6" fill="currentColor" stroke="none" />], 18),
  slice: S(<path d="M3 13L13 3M9.5 3H13v3.5M3 9.5V13h3.5" />, 18),
  line: S(<path d="M3 13L13 3" />, 18),
  arrow: S(<path d="M3 13L13 3M7.5 3H13v5.5" />, 18),
  polygon: S(<path d="M8 2.5l6 10.5H2z" />, 18),
  star: S(<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />, 18),
  // pen nib pointing to the bottom-left, like Figma
  pen: S([<path key="a" d="M2.5 13.5l1.4-5.3 5.6-4.4 2.7 2.7-4.4 5.6z" strokeLinejoin="round" />, <path key="b" d="M2.5 13.5l3.9-3.9" />, <circle key="c" cx="7.3" cy="8.7" r="1.1" />, <path key="d" d="M9.2 2.6l4.2 4.2" />], 18),
  pencil: S(<path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12zM9.5 4l2.5 2.5" />, 18),
  textPath: S([<path key="a" d="M2.5 13.5c3-5 8-5 11 0" />, <path key="b" d="M5 3.5h6M8 3.5v6" />], 18),
  spec: S([<rect key="a" x="3" y="2" width="10" height="12" rx="1.5" />, <path key="b" d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />], 18),
  // curly braces, like Figma's code tool
  code: S(<path d="M6 2.5c-1.6 0-2 .7-2 2v1.6c0 1-.5 1.6-1.5 1.9 1 .3 1.5.9 1.5 1.9v1.6c0 1.3.4 2 2 2M10 2.5c1.6 0 2 .7 2 2v1.6c0 1 .5 1.6 1.5 1.9-1 .3-1.5.9-1.5 1.9v1.6c0 1.3-.4 2-2 2" />, 18),
  annotation: S(<path d="M8 2.5a5.5 5.5 0 010 11H3.2a.7.7 0 01-.7-.7V8A5.5 5.5 0 018 2.5z" strokeLinejoin="round" />, 18),
  actions: S([<rect key="a" x="2.5" y="2.5" width="4.3" height="4.3" rx="1.2" />, <rect key="b" x="2.5" y="9.2" width="4.3" height="4.3" rx="1.2" />, <rect key="c" x="9.2" y="2.5" width="4.3" height="4.3" rx="1.2" />, <path key="d" d="M11.35 9.2v4.3M9.2 11.35h4.3" />], 18),
  chevDown: S(<path d="M4.5 6.5L8 10l3.5-3.5" strokeWidth="1.6" />, 10),
  tJustify:S(<path d="M3 4h10M3 8h10M3 12h10" />),
  vAlignTop: S(<path d="M3 2.5h10M8 13V5.5M5.5 8L8 5.5 10.5 8" />),
  vAlignMid: S(<path d="M3 8h10M8 2v3.5M8 14v-3.5M6 3.5L8 5.5l2-2M6 12.5l2-2 2 2" />),
  vAlignBottom: S(<path d="M3 13.5h10M8 3v7.5M5.5 8L8 10.5 10.5 8" />),
  listBullet: S([<circle key="a" cx="3.5" cy="4.5" r="0.9" fill="currentColor" />, <circle key="b" cx="3.5" cy="11.5" r="0.9" fill="currentColor" />, <path key="c" d="M6.5 4.5h7M6.5 11.5h7" />]),
  listNumber: S([<path key="a" d="M6.5 4.5h7M6.5 11.5h7" />, <path key="b" d="M2.5 3.2l1-0.7v4M2.3 9.8c.3-.6 1.7-.7 1.8.2.1.7-1.9 1.5-1.9 2.5h2" strokeWidth="1" />]),
  typeSettings: S(<path d="M3 4h4M10 4h3M3 8h7M3 12h2M8 12h5M7 2.5v3M10 6.5v3M5 10.5v3" />),
  lineHeight: S(<path d="M2.5 2.5h11M2.5 13.5h11M6 11l2-6 2 6M6.7 9h2.6" />, 14),
  letterSpacing: S(<path d="M2.5 3v10M13.5 3v10M6 11l2-6 2 6M6.7 9h2.6" />, 14),
  tAlignL:S(<path d="M3 4h10M3 8h6M3 12h8" />),
  tAlignC: S(<path d="M3 4h10M5 8h6M4 12h8" />),
  tAlignR: S(<path d="M3 4h10M7 8h6M5 12h8" />)
}

/** boolean operations: two overlapping squares, the kept area is filled */
export const BoolIcons = {
  UNION: S(<path d="M2.5 2.5h7v4h4v7h-7v-4h-4z" fill="currentColor" fillOpacity="0.35" />),
  SUBTRACT: S([<path key="a" d="M2.5 2.5h7v4h-3v3h-4z" fill="currentColor" fillOpacity="0.35" />, <path key="b" d="M9.5 6.5h4v7h-7v-4" strokeOpacity="0.55" />]),
  INTERSECT: S([<path key="a" d="M6.5 6.5h3v3h-3z" fill="currentColor" fillOpacity="0.45" />, <path key="b" d="M6.5 6.5v-4h-4v7h4M9.5 9.5v4h4v-7h-4" strokeOpacity="0.55" />]),
  EXCLUDE: S(<path d="M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7z" fill="currentColor" fillOpacity="0.35" fillRule="evenodd" />),
  FLATTEN: S(<path d="M8 2.5v7M5 6.8l3 3 3-3M3 13h10" />)
}

export function TypeIcon({ type }: { type: string }) {
  if (type in BoolIcons) return BoolIcons[type as keyof typeof BoolIcons]
  switch (type) {
    case 'FRAME':
      return S(<path d="M5 2v12M11 2v12M2 5h12M2 11h12" />, 14)
    case 'GROUP':
      return Icons.group
    case 'RECTANGLE':
      return S(<rect x="3" y="3" width="10" height="10" rx="0.5" />, 14)
    case 'ELLIPSE':
      return S(<circle cx="8" cy="8" r="5" />, 14)
    case 'TEXT':
      return S(<path d="M4 4h8M8 4v9" />, 14)
    case 'SECTION':
      return S([<rect key="a" x="2" y="2.5" width="12" height="11" rx="1.5" />, <rect key="b" x="3.8" y="4.2" width="5" height="2.2" rx="0.6" fill="currentColor" stroke="none" />], 14)
    case 'SLICE':
      return S(<path d="M3 13L13 3M9.5 3H13v3.5M3 9.5V13h3.5" />, 14)
    case 'SPEC':
      return S([<rect key="a" x="3" y="2" width="10" height="12" rx="1.5" />, <path key="b" d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />], 14)
    case 'CODE':
      return S(<path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5" />, 14)
    case 'MASK':
      return S([<circle key="a" cx="8" cy="8" r="5.5" />, <path key="b" d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" />], 14)
    case 'IMAGE':
      return S([<rect key="a" x="2" y="3" width="12" height="10" rx="1" />, <path key="c" d="M2.5 12l4-4 3 3 1.5-1.5 2.5 2.5" />], 14)
    default:
      return Icons.vector
  }
}
