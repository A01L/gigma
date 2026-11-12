// UI test (run in a project tab via scripts/cdp.mjs): simulates layers pasted from Figma whose
// image bytes are missing, then checks placeholder, inspector buttons, the no-token path and
// replacing the image by pasting a PNG onto the selected layer.
;(async () => {
  const ed = window.editor
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const res = {}
  ed.addPage('Figma image test')
  const fake = 'ab'.repeat(20) // 40-hex Figma-style hash with no blob in this project
  const n = ed.act(() =>
    ed.addNode({ type: 'RECTANGLE', name: 'Photo', x: 0, y: 0, width: 300, height: 200, fills: [{ type: 'IMAGE', imageHash: fake, scaleMode: 'FILL', figmaFileKey: 'TESTKEY' }] })
  )
  ed.zoomToFit()
  ed.setSelection([n.id])
  await wait(600)
  const btns = [...document.querySelectorAll('.panel.right .btn')].map((b) => b.innerText)
  res.inspectorButtons = btns
  res.hint = document.querySelector('.panel.right .hint')?.innerText ?? null
  // click "Load from Figma" -> without a token we expect the settings hint toast
  const load = [...document.querySelectorAll('.panel.right .btn')].find((b) => /Figma/.test(b.innerText))
  load?.click()
  await wait(800)
  res.toast = document.querySelector('.toast')?.innerText ?? null
  // replace by pasting a PNG while the layer is selected
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 4
  const g = c.getContext('2d')
  g.fillStyle = '#ff0066'
  g.fillRect(0, 0, 4, 4)
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'x.png', { type: 'image/png' }))
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
  await wait(800)
  const f = ed.nodes.get(n.id).fills.find((x) => x.type === 'IMAGE')
  res.replaced = f.imageHash !== fake
  res.figmaKeyCleared = !f.figmaFileKey
  res.hintAfter = document.querySelector('.panel.right .hint')?.innerText ?? null
  ed.deletePage(ed.currentPageId)
  return res
})()
