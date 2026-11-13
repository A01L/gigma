// The command bus. Everything that mutates a document from the outside
// (MCP tools today, plugins tomorrow) goes through these typed commands,
// which the editor executes as normal undoable operations.

export type CommandName =
  | 'list_projects'
  | 'create_project'
  | 'open_project'
  | 'list_tabs'
  | 'switch_tab'
  | 'get_document'
  | 'list_pages'
  | 'create_page'
  | 'set_current_page'
  | 'get_selection'
  | 'set_selection'
  | 'get_node'
  | 'find_nodes'
  | 'create_frame'
  | 'create_rectangle'
  | 'create_ellipse'
  | 'create_text'
  | 'create_svg'
  | 'create_image'
  | 'update_node'
  | 'delete_nodes'
  | 'group_nodes'
  | 'export_png'
  | 'get_screenshot'
  | 'create_shape'
  | 'create_spec'
  | 'list_specs'
  | 'update_spec'
  | 'create_code'
  | 'list_annotations'
  | 'create_annotation'
  | 'resolve_annotation'
  | 'ungroup_nodes'
  | 'link_spec'
  | 'add_variant'
  | 'set_variant'
  | 'list_styles'
  | 'create_style'
  | 'update_style'
  | 'delete_style'
  | 'create_component'
  | 'create_instance'
  | 'detach_instance'
  | 'outline_stroke'
  | 'boolean_operation'
  | 'flatten_nodes'
  | 'duplicate_nodes'
  | 'reorder_nodes'
  | 'align_nodes'
  | 'update_page'
  | 'delete_page'
  | 'export_svg'
  | 'export_pdf'
  | 'zoom_to'

export interface CommandRequest {
  id: string
  name: CommandName
  args: Record<string, unknown>
  /** nickname of the AI client behind an MCP call: the editor shows its cursor on the layer it touched */
  client?: string
}

export interface CommandResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}
