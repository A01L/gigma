// run in #doc= of the "Batch2 test" project: rotate and resize a rotated layer with synthetic pointer events
(() => {
  const out = {}
  const canvas = document.querySelector('.canvas-wrap canvas')
  const cr = canvas.getBoundingClientRect()
  const byName = (name) => [...editor.nodes.values()].find((n) => n.name === name)
  const toClient = (wx, wy) => ({ clientX: cr.left + wx * editor.camera.zoom + editor.camera.x, clientY: cr.top + wy * editor.camera.zoom + editor.camera.y })
  const ev = (type, pt, extra = {}) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...pt, ...extra }))
  const drag = (from, to, extra) => {
    ev('pointermove', from, { buttons: 0 })
    ev('pointerdown', from, extra)
    const mid = { clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2 }
    ev('pointermove', mid, extra)
    ev('pointermove', to, extra)
    ev('pointerup', to, extra)
  }
  out.camera = Object.keys(editor.camera)
  const n = byName('btn2') ?? editor.act(() => editor.addNode({ type: 'RECTANGLE', name: 'btn2', x: 900, y: 100, width: 200, height: 100, fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.6, b: 1, a: 1 } }] }))
  editor.act(() => editor.updateNode(n.id, { x: 900, y: 100, width: 200, height: 100, rotation: undefined }))
  editor.setSelection([n.id])
  const z = editor.camera.zoom
  // 1) rotate: grab just outside the top-right corner and swing to straight below the center => 135deg clockwise... use Shift for 15deg steps
  const c = { x: 1000, y: 150 }
  const start = toClient(1100 + 10 / z, 100 - 10 / z)
  // target: point at the same radius, rotated 90deg clockwise around the center
  const sx = 1100 + 10 / z - c.x
  const sy = 100 - 10 / z - c.y
  const end = toClient(c.x - sy, c.y + sx)
  drag(start, end)
  out.rotation = byName('btn2').rotation
  out.centerKept = [byName('btn2').x + 100, byName('btn2').y + 50]
  // 2) resize the rotated layer: it is drawn rotated 90deg clockwise, so its "east" edge points down on screen.
  // drag the middle of that edge 40px further down => width +40, the opposite edge stays put
  const before = editor.visualBounds(n.id)
  const edge = toClient(1000, 150 + 100)
  drag(edge, { clientX: edge.clientX, clientY: edge.clientY + 40 * z })
  const after = editor.visualBounds(n.id)
  const m = byName('btn2')
  out.size = [m.width, m.height]
  out.topEdgeKept = [Math.round(before.y), Math.round(after.y)]
  out.bottomMoved = Math.round(after.y + after.h - (before.y + before.h))
  editor.act(() => editor.deleteNode(n.id))
  return JSON.stringify(out)
})()
