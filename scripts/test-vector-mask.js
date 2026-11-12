// UI test (run in a project tab via scripts/cdp.mjs): decodes a synthetic Figma vector network,
// then builds a masked image group like Figma's "image masked by a pen-drawn shape".
;(async () => {
  const { vectorNetworkToSegs } = await import('/editor/figma-clipboard.ts')
  const { segsToD } = await import('/editor/svgpath.ts')
  // network: 4 vertices of a slanted quad, 4 segments (one curved), 1 region loop
  const V = [
    [20, 0],
    [100, 10],
    [80, 200],
    [0, 180]
  ]
  const S = [
    [0, 1, 0, 0, 0, 0],
    [1, 2, 30, 40, -10, -60], // curved edge
    [2, 3, 0, 0, 0, 0],
    [3, 0, 0, 0, 0, 0]
  ]
  const buf = new ArrayBuffer(12 + V.length * 12 + S.length * 28 + 8 + 4 + 16)
  const dv = new DataView(buf)
  let o = 0
  const u = (v) => (dv.setUint32(o, v, true), (o += 4))
  const f = (v) => (dv.setFloat32(o, v, true), (o += 4))
  u(V.length), u(S.length), u(1)
  for (const [x, y] of V) u(0), f(x), f(y)
  for (const [a, b, t0x, t0y, t1x, t1y] of S) u(0), u(a), f(t0x), f(t0y), u(b), f(t1x), f(t1y)
  u(1), u(1), u(4), u(0), u(1), u(2), u(3)
  const net = vectorNetworkToSegs(new Uint8Array(buf))
  const d = segsToD(net.segs)

  const ed = window.editor
  ed.addPage('Mask test')
  // photo-like rectangle (gradient stripes via several rects) masked by the decoded shape
  ed.act(() => {
    const g = ed.addNode({ type: 'GROUP', name: 'Masked', x: 0, y: 0, width: 300, height: 200 })
    ed.addNode({ type: 'VECTOR', name: 'Mask', parentId: g.id, x: 100, y: 0, width: 100, height: 200, path: d, pathBox: { w: 100, h: 200 }, isMask: true, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] })
    ed.addNode({ type: 'RECTANGLE', name: 'Orange', parentId: g.id, x: 0, y: 0, width: 300, height: 200, opacity: 0.8, fills: [{ type: 'SOLID', color: { r: 0.96, g: 0.66, b: 0.2, a: 1 } }] })
    ed.addNode({ type: 'RECTANGLE', name: 'Unmasked below', x: 340, y: 0, width: 100, height: 200, fills: [{ type: 'SOLID', color: { r: 0.3, g: 0.6, b: 1, a: 1 } }] })
  })
  ed.zoomToFit()
  ed.setSelection([])
  await new Promise((r) => setTimeout(r, 500))
  return { d, closed: net.closed, evenOdd: net.evenOdd }
})()
