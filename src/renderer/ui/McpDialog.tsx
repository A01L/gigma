import { useEffect, useState } from 'react'
import type { McpStatus } from '@shared/api'
import { backend } from '../backend'

export function McpDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<McpStatus | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    backend.mcp.status().then(setS)
  }, [])
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>AI control (MCP)</h2>
        {!s ? (
          'Loading…'
        ) : (
          <>
            <p>
              <span className="status-dot" style={{ background: s.running ? '#14ae5c' : '#f24822' }} />
              {s.running ? (
                <>
                  Local MCP server is running at <b>{s.url}</b> (only this computer can connect).
                </>
              ) : (
                s.error ?? 'MCP server is not running.'
              )}
            </p>
            {s.running && (
              <>
                <p>
                  <b>Claude Desktop</b>: Settings → Developer → Edit Config, add this to <code>claude_desktop_config.json</code> and restart Claude:
                </p>
                <pre>{s.claudeDesktopConfig}</pre>
                <p>
                  <b>Clients with HTTP support</b> (Cursor, VS Code, Claude Code, LM Studio…): add a server of type “http” with URL <code>{s.url}</code>.
                </p>
                <p className="muted">
                  ChatGPT only connects to MCP servers reachable over HTTPS from the internet; to use it you would need to expose this port through a tunnel yourself.
                  Gigma never does that automatically.
                </p>
              </>
            )}
          </>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          {s?.running && (
            <button
              className="btn"
              onClick={async () => {
                await backend.mcp.copyConfig()
                setCopied(true)
              }}
            >
              {copied ? 'Copied ✓' : 'Copy Claude config'}
            </button>
          )}
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
