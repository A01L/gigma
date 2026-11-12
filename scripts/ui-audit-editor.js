// Creates one of every node type in the open tab, selects each in turn and runs the layout audit.
// Usage: node scripts/cdp.mjs "#doc=" @scripts/ui-audit-editor.js
;(async () => {
  const ed = window.editor
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const audit = () => {
    const out = []
    for (const c of document.querySelectorAll('.panel, .toolbar')) {
      const cr = c.getBoundingClientRect()
      for (const el of c.querySelectorAll('*')) {
        const s = getComputedStyle(el)
        if (s.display === 'none' || s.visibility === 'hidden') continue
        const r = el.getBoundingClientRect()
        if (!r.width) continue
        if (r.right - cr.right > 1 || cr.left - r.left > 1) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} "${(el.innerText || '').slice(0, 20)}" +${Math.round(r.right - cr.right)}`)
      }
    }
    return out
  }
  // build a scratch page with all node kinds
  ed.addPage('Audit')
  const ids = ed.act(() => {
    const f = ed.addNode({ type: 'FRAME', name: 'Frame with a very very long name to test ellipsis', x: 0, y: 0, width: 400, height: 300, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }] })
    const r = ed.addNode({ type: 'RECTANGLE', parentId: f.id, x: 10, y: 10, width: 50, height: 50, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2 }] })
    const e = ed.addNode({ type: 'ELLIPSE', parentId: f.id, x: 80, y: 10, width: 50, height: 50, fills: [{ type: 'SOLID', color: { r: 0, g: 1, b: 0, a: 1 } }] })
    const t = ed.addNode({ type: 'TEXT', parentId: f.id, x: 10, y: 80, characters: 'Hello', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] })
    const v = ed.addNode({ type: 'VECTOR', parentId: f.id, x: 150, y: 10, width: 40, height: 40, path: 'M0 0L40 0L20 40Z', pathBox: { w: 40, h: 40 }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }] })
    return { f: f.id, r: r.id, e: e.id, t: t.id, v: v.id }
  })
  const g = ed.group([ids.r, ids.e])
  const report = {}
  for (const [name, sel] of Object.entries({ none: [], frame: [ids.f], rect: [ids.r], ellipse: [ids.e], text: [ids.t], vector: [ids.v], group: [g], multi: [ids.t, ids.v] })) {
    ed.setSelection(sel)
    await wait(250)
    const p = audit()
    if (p.length) report[name] = p.slice(0, 8)
  }
  // clean up: delete the audit page
  ed.deletePage(ed.currentPageId)
  return { viewport: `${innerWidth}x${innerHeight}`, problems: report }
})()
