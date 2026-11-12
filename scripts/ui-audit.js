// Layout audit (evaluated in a page via scripts/cdp.mjs): reports elements that stick out of
// their panel or the window. Usage: node scripts/cdp.mjs "#doc=" @scripts/ui-audit.js
;(() => {
  const out = []
  const vw = window.innerWidth
  const vh = window.innerHeight
  const containers = [...document.querySelectorAll('.panel, .home-side, .home-main, .tabbar, .toolbar, .gsel-pop, .cpick, .modal')]
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''
    const txt = (el.innerText || el.getAttribute?.('title') || '').trim().slice(0, 30)
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`
  }
  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  for (const c of containers) {
    if (!visible(c)) continue
    const cr = c.getBoundingClientRect()
    for (const el of c.querySelectorAll('*')) {
      if (!visible(el) || el.closest('svg') !== null && el.tagName !== 'svg') continue
      // skip content inside vertical scrollers below the fold
      const r = el.getBoundingClientRect()
      const overRight = r.right - cr.right
      const overLeft = cr.left - r.left
      if (overRight > 1 || overLeft > 1) out.push({ in: describe(c), el: describe(el), overRight: Math.round(overRight), overLeft: Math.round(overLeft) })
    }
    if (cr.right > vw + 1 || cr.left < -1 || cr.bottom > vh + 1) out.push({ windowOverflow: describe(c), right: Math.round(cr.right), vw })
  }
  // text that is cut without an ellipsis
  for (const el of document.querySelectorAll('button, .tab-name, .name, .title, label')) {
    if (!visible(el)) continue
    const s = getComputedStyle(el)
    if (el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && s.overflow !== 'visible' && el.children.length === 0)
      out.push({ clippedText: describe(el), scroll: el.scrollWidth, client: el.clientWidth })
  }
  return { viewport: `${vw}x${vh}`, problems: out.slice(0, 40), count: out.length }
})()
