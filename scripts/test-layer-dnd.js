// run in #doc= of the "Batch1 test" project: synthetic HTML5 drag & drop on the layers panel
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const byName = (name) => [...editor.nodes.values()].find((n) => n.name === name)
  const row = (name) => [...document.querySelectorAll('.layers .list-row')].find((r) => r.textContent.trim() === name)
  const drag = async (from, to, frac) => {
    const dt = new DataTransfer()
    const a = row(from)
    const b = row(to)
    if (!a || !b) return 'row missing: ' + (!a ? from : to)
    a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const r = b.getBoundingClientRect()
    const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + 30, clientY: r.y + r.height * frac }
    b.dispatchEvent(new DragEvent('dragover', init))
    await wait(50)
    const cls = b.className
    b.dispatchEvent(new DragEvent('drop', init))
    await wait(100)
    return cls
  }
  const out = {}
  const order = () => {
    const p = byName('a').parentId
    return editor.children(p).map((id) => editor.nodes.get(id).name).join(',')
  }
  out.before = order()
  // a is below b in z-order (created first); drop a onto the upper part of b's row => a goes above b
  out.hl1 = await drag('a', 'b', 0.1)
  out.afterAbove = order()
  out.hl2 = await drag('a', 'b', 0.9)
  out.afterBelow = order()
  // move b out of the wrapping frame into F (drop inside)
  out.hl3 = await drag('b', 'F', 0.5)
  out.bParent = editor.nodes.get(byName('b').parentId)?.name
  editor.undo()
  out.undoParent = editor.nodes.get(byName('b').parentId)?.name
  return JSON.stringify(out)
})()
