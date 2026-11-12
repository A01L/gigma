// What every plugin page gets from Gigma: the `gigma` API (injected into the page), an optional
// stylesheet that matches the app, and the starter plugin.

/** Runs inside the plugin's sandboxed frame. Plain ES2020, no dependencies. */
export const BRIDGE_JS = String.raw`(() => {
  if (window.gigma) return
  const pending = new Map()
  const listeners = {}
  let seq = 0
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      parent.postMessage({ gigma: 'call', id, method, params }, '*')
    })
  const emit = (name, data) => {
    for (const fn of listeners[name] || []) {
      try { fn(data) } catch (err) { console.error(err) }
    }
  }
  const applyTheme = (theme) => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }
  addEventListener('message', (e) => {
    if (e.source !== parent) return
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.gigma === 'reply') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.result)
    } else if (m.gigma === 'event') {
      if (m.name === 'themechange') applyTheme(m.data)
      emit(m.name, m.data)
    }
  })
  const toSource = async (src) => {
    if (typeof src === 'string') return src
    const blob = src instanceof Blob ? src : new Blob([src])
    return await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(r.error)
      r.readAsDataURL(blob)
    })
  }
  const gigma = {
    /** plugin, theme, locale and selection at start; filled when gigma.ready resolves */
    info: null,
    command: (name, args) => call('command', { name, args: args || {} }),
    selection: () => call('selection'),
    viewport: () => call('viewport'),
    notify: (text) => call('notify', { text: String(text) }),
    close: () => call('close'),
    resize: (width, height) => call('resize', { width, height }),
    createImage: async (source) => call('createImage', { source: await toSource(source) }),
    fetch: (url, options) => call('fetch', { url, as: (options && options.as) || 'text' }),
    capturePage: (options) => call('capturePage', options),
    storage: {
      get: (key) => call('storageGet', { key }),
      set: (key, value) => call('storageSet', { key, value })
    },
    /** everything done inside fn becomes ONE step of undo */
    undoGroup: async (fn) => {
      await call('beginUndo')
      try { return await fn() } finally { await call('endUndo') }
    },
    undo: () => call('undo'),
    redo: () => call('redo'),
    on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn)
      return () => gigma.off(name, fn)
    },
    off(name, fn) {
      listeners[name] = (listeners[name] || []).filter((f) => f !== fn)
    }
  }
  gigma.ready = call('hello').then((info) => {
    gigma.info = info
    applyTheme(info.theme)
    return info
  })
  // Ctrl+Z / Ctrl+Shift+Z keep working while the plugin window has the focus
  addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyZ') return
    const t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    e.preventDefault()
    call(e.shiftKey ? 'redo' : 'undo')
  })
  window.gigma = gigma
})()`

/** <link rel="stylesheet" href="/@gigma/ui.css">: controls that look like the app, in both themes */
export const UI_CSS = `:root {
  --bg: #2c2c2c; --panel: #383838; --panel-2: #444; --border: #4a4a4a;
  --text: #f2f2f2; --text-2: #b8b8b8; --text-3: #8a8a8a;
  --accent: #0d99ff; --accent-text: #fff; --danger: #f24822; --radius: 6px;
  color-scheme: dark;
}
:root[data-theme='light'] {
  --bg: #ffffff; --panel: #f5f5f5; --panel-2: #ebebeb; --border: #e0e0e0;
  --text: #1e1e1e; --text-2: #5c5c5c; --text-3: #8f8f8f;
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 12px/1.45 Inter, 'Segoe UI', system-ui, -apple-system, sans-serif;
  padding: 12px; overflow: auto; user-select: none;
}
h1, h2, h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
p { margin: 0 0 8px; color: var(--text-2); }
label { display: block; margin: 0 0 4px; color: var(--text-2); }
input[type='text'], input[type='number'], input[type='url'], input:not([type]), select, textarea {
  width: 100%; height: 30px; padding: 0 8px; border-radius: var(--radius);
  border: 1px solid transparent; background: var(--panel); color: var(--text); font: inherit; outline: none;
}
textarea { height: auto; padding: 8px; resize: vertical; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); }
input[type='range'] { width: 100%; accent-color: var(--accent); }
input[type='color'] { width: 34px; height: 30px; padding: 2px; border: none; border-radius: var(--radius); background: var(--panel); cursor: pointer; }
button, .btn {
  height: 30px; padding: 0 12px; border-radius: var(--radius); border: 1px solid var(--border);
  background: transparent; color: var(--text); font: inherit; font-weight: 500; cursor: pointer; white-space: nowrap;
}
button:hover, .btn:hover { background: var(--panel); }
button.primary, .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.primary:hover, .btn.primary:hover { filter: brightness(1.08); }
button:disabled { opacity: 0.45; cursor: default; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.row > * { flex: 1; min-width: 0; }
.row > .fixed, .row > input[type='color'], .row > input[type='checkbox'] { flex: none; }
.field { margin-bottom: 10px; }
.muted { color: var(--text-3); }
.card { background: var(--panel); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 10px; }
.seg { display: flex; gap: 2px; padding: 2px; background: var(--panel); border-radius: var(--radius); margin-bottom: 10px; }
.seg button { flex: 1; height: 26px; border: none; }
.seg button.on { background: var(--bg); box-shadow: 0 0 0 1px var(--border); }
.stack > * + * { margin-top: 8px; }
.full { width: 100%; }
`

/** starter plugin saved by "Download template" */
export const TEMPLATE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <!-- optional: controls styled like Gigma, light and dark -->
    <link rel="stylesheet" href="/@gigma/ui.css" />
  </head>
  <body>
    <h3>My plugin</h3>
    <p id="status">Select something on the canvas.</p>

    <div class="row">
      <label style="margin:0">Color</label>
      <input type="color" id="color" value="#0d99ff" />
    </div>
    <div class="row">
      <button id="add" class="primary">Add a card</button>
      <button id="paint">Paint selection</button>
    </div>

    <script>
      // "gigma" is already there: Gigma injects it into every plugin page.
      const status = document.getElementById('status')
      const color = document.getElementById('color')

      const showSelection = (nodes) => {
        status.textContent = nodes.length ? 'Selected: ' + nodes.map((n) => n.name).join(', ') : 'Select something on the canvas.'
      }
      gigma.ready.then((info) => showSelection(info.selection))
      gigma.on('selectionchange', showSelection)

      document.getElementById('add').onclick = async () => {
        const view = await gigma.viewport()
        // everything inside undoGroup is undone with a single Ctrl+Z
        await gigma.undoGroup(async () => {
          const card = await gigma.command('create_frame', {
            name: 'Card', x: Math.round(view.centerX - 120), y: Math.round(view.centerY - 70),
            width: 240, height: 140, fill: color.value, cornerRadius: 16
          })
          await gigma.command('create_text', { text: 'Hello from a plugin', x: 20, y: 20, fontSize: 18, fontWeight: 600, color: '#FFFFFF', parentId: card.id })
          await gigma.command('set_selection', { ids: [card.id] })
        })
        gigma.notify('Card added')
      }

      document.getElementById('paint').onclick = async () => {
        const nodes = await gigma.selection()
        if (!nodes.length) return gigma.notify('Nothing is selected')
        await gigma.undoGroup(async () => {
          for (const n of nodes) await gigma.command('update_node', { id: n.id, fill: color.value })
        })
      }
    </script>
  </body>
</html>
`
