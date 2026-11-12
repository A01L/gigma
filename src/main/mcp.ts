// Built-in MCP server. Listens ONLY on 127.0.0.1 (Streamable HTTP, stateless).
// Every tool is a thin wrapper over the editor command bus (src/shared/commands.ts),
// so AI edits are regular undoable operations and show up live on the canvas.
//
// Clients:
//  - Streamable-HTTP capable clients: http://127.0.0.1:<port>/mcp
//  - stdio-only clients (Claude Desktop): bin/gigma-mcp.cjs proxies stdio <-> HTTP
import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { CommandName } from '../shared/commands'

export type RunCommand = (name: CommandName, args: Record<string, unknown>) => Promise<unknown>

const color = z.string().describe('Hex color, e.g. "#FF5733" or "#FF573380" (with alpha)')
const parent = z.string().optional().describe('Parent frame/group id. Omit to place on the page root.')
/** Figma-style typography options shared by create_text and update_node */
const typographyShape = {
  italic: z.boolean().optional(),
  verticalAlign: z.enum(['TOP', 'CENTER', 'BOTTOM']).optional().describe('Vertical alignment inside a fixed-size text box'),
  decoration: z.enum(['NONE', 'UNDERLINE', 'STRIKETHROUGH']).optional(),
  textCase: z.enum(['ORIGINAL', 'UPPER', 'LOWER', 'TITLE']).optional(),
  lineHeightPercent: z.number().min(0).optional().describe('Line height in % of font size (overrides lineHeight)'),
  letterSpacingPercent: z.number().optional().describe('Letter spacing in % of font size, e.g. -2'),
  paragraphSpacing: z.number().min(0).optional(),
  listStyle: z.enum(['NONE', 'BULLET', 'NUMBER']).optional(),
  truncate: z.boolean().optional().describe('Fixed-size text ends with "…" when it overflows'),
  verticalTrim: z.enum(['STANDARD', 'CAP_HEIGHT']).optional().describe('CAP_HEIGHT = tight box from cap height to baseline'),
  wrapStyle: z.enum(['AUTO', 'BALANCED']).optional().describe('BALANCED = even line lengths (good for headings)')
}

const box = {
  x: z.number().default(0),
  y: z.number().default(0),
  width: z.number().positive(),
  height: z.number().positive()
}

/** Every command with its argument schema: shared by MCP and by plugins (same names, same arguments). */
const TOOLS = new Map<CommandName, { description: string; shape: z.ZodRawShape; map: (a: Record<string, unknown>) => Record<string, unknown> }>()
function tools(): typeof TOOLS {
  if (!TOOLS.size) buildServer(async () => null)
  return TOOLS
}

/** commands that act on the application, not on a document: MCP only */
const APP_COMMANDS = new Set<string>(['list_projects', 'create_project', 'open_project', 'list_tabs', 'switch_tab'])

/** Check the arguments of a command sent by a plugin and fill in the defaults, exactly as for MCP calls. */
export function prepareCommand(name: string, args: unknown): { name: CommandName; args: Record<string, unknown> } {
  const def = tools().get(name as CommandName)
  if (!def || APP_COMMANDS.has(name)) throw new Error(`Unknown command "${name}"`)
  const parsed = z.object(def.shape).safeParse(args ?? {})
  if (!parsed.success) throw new Error(`${name}: ` + parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  return { name: name as CommandName, args: def.map(parsed.data as Record<string, unknown>) }
}

/** Markdown reference of the document commands (for the plugin documentation). */
export function commandReference(): string {
  let out = ''
  for (const [name, def] of tools()) {
    if (APP_COMMANDS.has(name)) continue
    out += `### \`${name}\`\n\n${def.description}\n\n`
    const schema = z.toJSONSchema(z.object(def.shape), { io: 'input' }) as { properties?: Record<string, Record<string, unknown>>; required?: string[] }
    const props = Object.entries(schema.properties ?? {})
    if (!props.length) {
      out += '_No arguments._\n\n'
      continue
    }
    const typeOf = (p: Record<string, unknown>): string => {
      if (Array.isArray(p.enum)) return p.enum.map((v) => JSON.stringify(v)).join(' \\| ')
      if (Array.isArray(p.anyOf)) return (p.anyOf as Record<string, unknown>[]).map(typeOf).join(' \\| ')
      if (p.type === 'array') return `array of ${p.items ? typeOf(p.items as Record<string, unknown>) : 'any'}`
      if (p.type === 'object') return 'object {' + Object.keys((p.properties as object) ?? {}).join(', ') + '}'
      return String(p.type ?? 'any')
    }
    out += '| Argument | Type | Required | Description |\n|---|---|---|---|\n'
    for (const [k, p] of props) {
      const req = schema.required?.includes(k) ? 'yes' : p.default !== undefined ? `default ${JSON.stringify(p.default)}` : ''
      out += `| \`${k}\` | ${typeOf(p)} | ${req} | ${String(p.description ?? '').replace(/\|/g, '\\|')} |\n`
    }
    out += '\n'
  }
  return out
}

function buildServer(run: RunCommand): McpServer {
  const server = new McpServer(
    { name: 'gigma', version: '0.1.0' },
    {
      instructions:
        'Gigma is a local Figma-like design tool. Coordinates are in pixels; x/y of a child are relative to its parent frame. ' +
        'Projects open in tabs; document tools act on the active tab (see list_tabs / switch_tab). ' +
        'Typical flow: create_frame (e.g. 1080x1080 for an Instagram post) -> add shapes/text/svg/images with parentId = frame id -> export_png to check the result. ' +
        'Use get_document / get_selection to inspect what the user is working on, get_screenshot to see exactly what is on their screen, ' +
        'and export_png to look at a node or the whole page after your changes. update_node exposes every inspector property ' +
        '(fills incl. images, strokes with alignment, corner radius, opacity, effects, masks, clip content, full typography); ' +
        'align_nodes / reorder_nodes / duplicate_nodes / group_nodes / ungroup_nodes mirror the inspector and layer actions. ' +
        'The user may leave tasks as Spec cards (list_specs) and notes as annotations (list_annotations): check them, do the work, then update_spec / resolve_annotation. ' +
        'For complex layouts you can use create_code (HTML + CSS rendered as a design block) instead of placing every element by coordinates.'
    }
  )

  const tool = (
    name: CommandName,
    description: string,
    shape: z.ZodRawShape,
    map: (a: Record<string, unknown>) => Record<string, unknown> = (a) => a
  ) => {
    TOOLS.set(name, { description, shape, map })
    server.registerTool(name, { description, inputSchema: shape }, async (args: Record<string, unknown>) => {
      try {
        const result = await run(name, map(args))
        if (result && typeof result === 'object' && 'pngBase64' in (result as object)) {
          const r = result as { pngBase64: string; width: number; height: number }
          return {
            content: [
              { type: 'image' as const, data: r.pngBase64, mimeType: 'image/png' },
              { type: 'text' as const, text: `PNG ${r.width}x${r.height}` }
            ]
          }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }) }] }
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: String((e as Error).message ?? e) }] }
      }
    })
  }

  tool('list_projects', 'List design projects in the local Gigma library.', {})
  tool('create_project', 'Create a new project in the library and open it in the editor.', { name: z.string().default('Untitled') })
  tool('open_project', 'Open a project from list_projects in a tab (or focus its tab if already open).', { path: z.string() })
  tool('list_tabs', 'List open project tabs and which one is active. Document tools act on the active tab.', {})
  tool('switch_tab', 'Activate a project tab by id (null = Home).', { tabId: z.string().nullable() })
  tool('get_document','Get pages and a compact tree of nodes on the current page (or a given page).', {
    pageId: z.string().optional(),
    depth: z.number().int().min(1).max(20).default(4)
  })
  tool('list_pages', 'List pages of the open document.', {})
  tool('create_page', 'Create a new page and switch to it.', { name: z.string() })
  tool('set_current_page', 'Switch the visible page.', { pageId: z.string() })
  tool('get_selection', 'Get the nodes the user currently has selected.', {})
  tool('set_selection', 'Select nodes by id (empty array clears selection).', { ids: z.array(z.string()) })
  tool('get_node', 'Get full properties of a node.', { id: z.string() })
  tool('find_nodes', 'Find nodes on the current page by name substring and/or type.', {
    name: z.string().optional(),
    type: z.enum(['FRAME', 'GROUP', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'VECTOR', 'IMAGE']).optional()
  })
  // auto layout, same fields as the Figma plugin API
  const layoutShape = {
    layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional().describe('Auto layout: stack children in a row or a column (NONE turns it off)'),
    itemSpacing: z.number().optional().describe('Auto layout: gap between children'),
    padding: z
      .union([z.number().min(0), z.array(z.number().min(0)).length(4)])
      .optional()
      .describe('Auto layout padding: one number or [top, right, bottom, left]'),
    primaryAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']).optional().describe('Auto layout: alignment along the layout direction'),
    counterAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX']).optional().describe('Auto layout: alignment across the layout direction'),
    layoutWrap: z.enum(['NO_WRAP', 'WRAP']).optional().describe('Auto layout: WRAP = items that do not fit continue on the next line (needs a FIXED size along the layout direction)'),
    counterAxisSpacing: z.number().optional().describe('Auto layout with WRAP: gap between the lines'),
    primaryAxisSizingMode: z.enum(['FIXED', 'AUTO']).optional().describe('Auto layout: AUTO = hug contents along the layout direction'),
    counterAxisSizingMode: z.enum(['FIXED', 'AUTO']).optional().describe('Auto layout: AUTO = hug contents across the layout direction')
  }
  tool('create_frame', 'Create a frame (artboard). Use for screens, posts, cards. Frames clip their content. Pass layoutMode to make it an auto layout frame: children are then arranged automatically and their x / y are ignored.', {
    name: z.string().default('Frame'),
    ...box,
    fill: color.default('#FFFFFF'),
    cornerRadius: z.number().min(0).optional(),
    ...layoutShape,
    parentId: parent
  })
  tool('create_rectangle', 'Create a rectangle.', {
    name: z.string().optional(),
    ...box,
    fill: color.optional(),
    stroke: color.optional(),
    strokeWeight: z.number().min(0).optional(),
    cornerRadius: z.number().min(0).optional(),
    opacity: z.number().min(0).max(1).optional(),
    parentId: parent
  })
  tool('create_ellipse', 'Create an ellipse.', {
    name: z.string().optional(),
    ...box,
    fill: color.optional(),
    stroke: color.optional(),
    strokeWeight: z.number().min(0).optional(),
    opacity: z.number().min(0).max(1).optional(),
    parentId: parent
  })
  tool('create_text', 'Create a text layer. Width is optional (auto width when omitted).', {
    text: z.string(),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().positive().optional(),
    fontSize: z.number().positive().default(16),
    fontWeight: z.number().int().min(100).max(900).default(400),
    fontFamily: z.string().default('Inter'),
    color: color.default('#000000'),
    align: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']).default('LEFT'),
    ...typographyShape,
    lineHeight: z.number().positive().optional(),
    name: z.string().optional(),
    parentId: parent
  })
  tool(
    'create_svg',
    'Import SVG markup as editable vector layers (paths, shapes, text) inside a new group. Ideal for icons, illustrations, logos.',
    {
      svg: z.string().describe('Full <svg>...</svg> markup'),
      x: z.number().default(0),
      y: z.number().default(0),
      width: z.number().positive().optional().describe('Scale to this width (keeps aspect ratio)'),
      name: z.string().optional(),
      parentId: parent
    }
  )
  tool('create_image', 'Insert a raster image from base64 data, a data: URL or a local file path.', {
    source: z.string().optional().describe('base64 string, data:image/...;base64,..., or absolute local file path'),
    imageHash: z.string().optional().describe('Instead of source: an image already in the project (plugins get one from gigma.createImage)'),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    scaleMode: z.enum(['FILL', 'FIT', 'STRETCH']).default('FILL'),
    name: z.string().optional(),
    parentId: parent
  })
  tool('update_node', 'Change properties of a node. Only provided fields are changed.', {
    id: z.string(),
    name: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    fill: color.optional(),
    stroke: color.optional(),
    strokeWeight: z.number().min(0).optional(),
    cornerRadius: z.number().min(0).optional(),
    opacity: z.number().min(0).max(1).optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    text: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontWeight: z.number().int().optional(),
    fontFamily: z.string().optional(),
    align: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']).optional(),
    ...typographyShape,
    parentId: z.string().nullable().optional().describe('Move into another parent (null = page root)'),
    strokeAlign: z.enum(['INSIDE', 'CENTER', 'OUTSIDE']).optional(),
    isMask: z.boolean().optional().describe('Use this layer as a mask for the siblings above it'),
    effects: z
      .array(
        z.object({
          type: z.enum(['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR']),
          color: color.optional().describe('Shadow color with alpha, e.g. "#00000040"'),
          x: z.number().optional(),
          y: z.number().optional(),
          radius: z.number().min(0).default(4).describe('Blur radius'),
          spread: z.number().optional(),
          visible: z.boolean().optional()
        })
      )
      .optional()
      .describe('Replaces the layer effects (Figma-style). Empty array removes all effects.'),
    fills: z
      .array(
        z.object({
          type: z.enum(['SOLID', 'IMAGE', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL']),
          stops: z
            .array(z.object({ position: z.number().min(0).max(1), color }))
            .min(2)
            .optional()
            .describe('Gradients: colour stops'),
          angle: z.number().optional().describe('Linear gradient angle, CSS convention (180 = top to bottom, 90 = left to right)'),
          color: color.optional().describe('SOLID: hex color, alpha allowed'),
          source: z.string().optional().describe('IMAGE: base64, data: URL or absolute file path'),
          imageHash: z.string().optional().describe('IMAGE: reuse an image already in the project'),
          scaleMode: z.enum(['FILL', 'FIT', 'STRETCH']).optional(),
          visible: z.boolean().optional()
        })
      )
      .optional()
      .describe('Replaces all fills (bottom to top), like the Fill section in the inspector'),
    strokes: z
      .array(z.object({ color, weight: z.number().min(0).default(1), align: z.enum(['INSIDE', 'CENTER', 'OUTSIDE']).optional(), visible: z.boolean().optional() }))
      .optional()
      .describe('Replaces all strokes'),
    clipsContent: z.boolean().optional().describe('Frames: clip children to the frame'),
    textAutoResize: z.enum(['WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE']).optional().describe('Text: auto width / auto height / fixed size'),
    lineHeight: z.number().min(0).optional().describe('Text line height in px'),
    letterSpacing: z.number().optional().describe('Text letter spacing in px'),
    cornerRadii: z.array(z.number().min(0)).length(4).optional().describe('Independent corners [topLeft, topRight, bottomRight, bottomLeft]'),
    rotation: z.number().optional().describe('Degrees around the center, counter-clockwise positive (as in Figma)'),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    constrainProportions: z.boolean().optional(),
    html: z.string().optional().describe('Code blocks: new HTML'),
    css: z.string().optional().describe('Code blocks: new CSS'),
    arrowEnd: z.boolean().optional().describe('Lines/paths: arrowhead at the end'),
    ...layoutShape,
    layoutGrow: z.number().min(0).max(1).optional().describe('Child of an auto layout frame: 1 = fill the frame along the layout direction'),
    layoutAlign: z.enum(['INHERIT', 'STRETCH']).optional().describe('Child of an auto layout frame: STRETCH = fill the frame across the layout direction'),
    layoutPositioning: z.enum(['AUTO', 'ABSOLUTE']).optional().describe('Child of an auto layout frame: ABSOLUTE = keep own x / y'),
    constraints: z
      .object({ horizontal: z.enum(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE']).optional(), vertical: z.enum(['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE']).optional() })
      .optional()
      .describe('What the layer does when its parent frame is resized: MIN = stay at the left / top, MAX = right / bottom, CENTER, STRETCH = both sides (resizes), SCALE = proportional'),
    fillStyleId: z.string().nullable().optional().describe('Link the fill to a colour style from list_styles (null = detach). The layer follows the style until its fill is edited.'),
    strokeStyleId: z.string().nullable().optional().describe('Link the stroke colour to a colour style (null = detach)'),
    textStyleId: z.string().nullable().optional().describe('Link a text layer to a text style from list_styles (null = detach)'),
    blendMode: z
      .enum(['NORMAL', 'DARKEN', 'MULTIPLY', 'COLOR_BURN', 'LIGHTEN', 'SCREEN', 'COLOR_DODGE', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'])
      .optional()
      .describe('How the layer mixes with the layers below it')
  })
  tool('delete_nodes', 'Delete nodes (and their children).', { ids: z.array(z.string()).min(1) })
  tool('group_nodes', 'Group sibling nodes.', { ids: z.array(z.string()).min(1), name: z.string().optional() })
  tool('ungroup_nodes', 'Ungroup groups (or frames): children move to the parent.', { ids: z.array(z.string()).min(1) })
  tool(
    'boolean_operation',
    'Combine shapes into one, like Figma: UNION adds them, SUBTRACT cuts the upper layers out of the bottom one, INTERSECT keeps the overlap, EXCLUDE keeps everything but the overlap. The layers stay editable inside the resulting boolean group, which takes the fill of the bottom layer. Pass the id of an existing boolean group alone to change its operation.',
    { ids: z.array(z.string()).min(1), operation: z.enum(['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE']), name: z.string().optional() }
  )
  tool(
    'create_component',
    'Make a main component from layers (a single frame is converted, several layers are wrapped in a frame). Instances made with create_instance follow every later change of the main component, keeping their own overrides (text, fills, strokes, effects, opacity, visibility).',
    { ids: z.array(z.string()).min(1), name: z.string().optional() }
  )
  tool('create_instance', 'Place an instance of a main component. Returns the instance and its layers, which can be overridden with update_node (e.g. text of a button label).', {
    componentId: z.string(),
    x: z.number(),
    y: z.number(),
    parentId: parent
  })
  tool('add_variant', 'Add a variant to a main component. The first call turns the component into a component set; variants are named "Property=Value, Property 2=Value". Returns the new variant (a main component you can edit and rename).', {
    componentId: z.string(),
    name: z.string().optional().describe('Name of the new variant, e.g. "State=Hover" or "Size=Large, State=Default"')
  })
  tool('set_variant', 'Switch an instance to another variant of its component set by property values, e.g. {"State": "Hover"}. Overrides of the instance are kept.', {
    instanceId: z.string(),
    properties: z.record(z.string(), z.string())
  })
  tool('list_styles', 'List the saved colour and text styles of the document.', {})
  tool('create_style', 'Save a colour style or a text style. Link layers to it with update_node (fillStyleId / strokeStyleId / textStyleId).', {
    kind: z.enum(['color', 'text']),
    name: z.string(),
    color: color.optional().describe('Colour styles: the colour'),
    fontFamily: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontWeight: z.number().int().optional(),
    lineHeight: z.number().min(0).optional().describe('px'),
    letterSpacing: z.number().optional().describe('px'),
    ...typographyShape
  })
  tool('update_style', 'Change a style: every layer linked to it changes too.', {
    id: z.string(),
    name: z.string().optional(),
    color: color.optional(),
    fontFamily: z.string().optional(),
    fontSize: z.number().positive().optional(),
    fontWeight: z.number().int().optional(),
    lineHeight: z.number().min(0).optional(),
    letterSpacing: z.number().optional(),
    ...typographyShape
  })
  tool('delete_style', 'Delete a style. Layers that used it keep their look.', { id: z.string() })
  tool('detach_instance', 'Turn instances into plain frames (no longer linked to the main component).', { ids: z.array(z.string()).min(1) })
  tool('outline_stroke', 'Convert the strokes of layers into filled vector shapes (Figma "Outline stroke").', { ids: z.array(z.string()).min(1) })
  tool('flatten_nodes', 'Replace layers (shapes, groups, boolean groups) with a single vector path: their merged outline.', { ids: z.array(z.string()).min(1) })
  tool('duplicate_nodes', 'Duplicate nodes (with children). Returns the new ids.', {
    ids: z.array(z.string()).min(1),
    offsetX: z.number().default(0),
    offsetY: z.number().default(0)
  })
  tool('reorder_nodes', 'Change layer order (z-index) among siblings.', {
    ids: z.array(z.string()).min(1),
    to: z.enum(['front', 'back', 'forward', 'backward'])
  })
  tool('align_nodes', 'Align or distribute layers like the inspector alignment buttons. One layer aligns to its parent frame.', {
    ids: z.array(z.string()).min(1),
    align: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom', 'distribute-horizontal', 'distribute-vertical'])
  })
  tool('update_page', 'Rename a page or change its canvas background.', {
    pageId: z.string().optional().describe('Defaults to the current page'),
    name: z.string().optional(),
    background: color.optional()
  })
  tool('delete_page', 'Delete a page (not the last one).', { pageId: z.string() })
  tool(
    'export_png',
    'Render a node, the current selection or the whole page to PNG and return the image so you can SEE the design. Use after changes to check your work.',
    {
      id: z.string().optional().describe('Node to render; omit for the selection, or the whole page when nothing is selected'),
      scale: z.number().min(0.05).max(4).default(1),
      maxSize: z.number().min(64).max(4096).default(1600).describe('Longest side limit in px (keeps images small)')
    }
  )
  tool(
    'get_screenshot',
    'Snapshot of exactly what the user currently sees on the canvas (viewport, zoom, selection highlight). Use to understand what the user is looking at.',
    { maxSize: z.number().min(64).max(4096).default(1400) }
  )
  tool('create_shape', 'Create a shape from the toolbar: line, arrow, polygon, star, section (container for frames) or slice (export area).', {
    kind: z.enum(['line', 'arrow', 'polygon', 'star', 'section', 'slice']),
    ...box,
    sides: z.number().int().min(3).max(60).optional().describe('polygon sides (default 3) / star points (default 5)'),
    innerRatio: z.number().min(0.05).max(1).optional().describe('star inner radius ratio (default 0.382)'),
    fill: color.optional(),
    stroke: color.optional(),
    strokeWeight: z.number().min(0).optional(),
    name: z.string().optional(),
    parentId: parent
  })
  tool(
    'list_specs',
    'List Spec cards — tasks the user left on the canvas for AI. Read them, do the work (design with the other tools), then call update_spec with status DONE and a short result.',
    { status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(), allPages: z.boolean().default(true) }
  )
  tool('update_spec', 'Update a Spec card (status, result notes, title, description).', {
    id: z.string(),
    status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']).optional(),
    result: z.string().optional().describe('What you did, shown on the card for the user'),
    title: z.string().optional(),
    body: z.string().optional()
  })
  tool('create_spec', 'Create a Spec card (task note) on the canvas.', {
    title: z.string(),
    body: z.string().default(''),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().positive().default(320),
    height: z.number().positive().default(220),
    parentId: parent
  })
  tool(
    'create_code',
    'Create a Code block: HTML + CSS rendered as design on the canvas (no coordinates needed inside). Use for complex layouts (cards, landing sections, UI) or to place a developer component. No scripts, no remote resources; images must be data: URLs.',
    {
      html: z.string(),
      css: z.string().default(''),
      x: z.number().default(0),
      y: z.number().default(0),
      width: z.number().positive().default(400),
      height: z.number().positive().default(300),
      name: z.string().optional(),
      parentId: parent
    }
  )
  tool('list_annotations', 'List annotations (notes the user pinned on the canvas). Each includes the layer under the pin.', {
    includeResolved: z.boolean().default(false),
    allPages: z.boolean().default(true)
  })
  tool('create_annotation', 'Pin a note on the canvas for the user (e.g. a question or an explanation of a change).', {
    text: z.string(),
    x: z.number(),
    y: z.number()
  })
  tool('resolve_annotation', 'Mark an annotation as resolved after acting on it.', { id: z.string() })
  tool('export_svg', 'Export a node as SVG markup.', { id: z.string() })
  tool('zoom_to', 'Scroll and zoom the user viewport to fit given nodes.', { ids: z.array(z.string()).min(1) })

  return server
}

export interface McpHandle {
  port: number
  close: () => void
}

export function startMcpServer(run: RunCommand, port: number, devScreenshot?: (part: string) => Promise<Buffer>): Promise<McpHandle> {
  const httpServer = http.createServer(async (req, res) => {
    // DNS-rebinding protection: only accept requests addressed to localhost.
    const host = (req.headers.host ?? '').split(':')[0]
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.writeHead(403).end()
      return
    }
    if (req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) {
      res.writeHead(403).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ app: 'gigma', ok: true }))
      return
    }
    if (url.pathname === '/debug/screenshot' && devScreenshot) {
      res.writeHead(200, { 'content-type': 'image/png' }).end(await devScreenshot(url.searchParams.get('part') ?? 'tab'))
      return
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const c of req) {
        size += (c as Buffer).length
        if (size > 64 * 1024 * 1024) throw new Error('payload too large')
        chunks.push(c as Buffer)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const server = buildServer(run)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        transport.close()
        server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: String((e as Error).message) }, id: null }))
      }
    }
  })
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, '127.0.0.1', () => resolve({ port, close: () => httpServer.close() }))
  })
}
