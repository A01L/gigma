// Behaviour of the landing page. No libraries: plain DOM.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches

  // mockups are drawn at a fixed design size and scaled down to the width they get
  const fits = [...document.querySelectorAll('.fit')]
  const layout = () => {
    for (const box of fits) {
      const w = +box.dataset.w
      const h = +box.dataset.h
      // data-min: below that scale the mockup keeps its size and scrolls sideways instead
      const s = Math.max(+(box.dataset.min || 0), Math.min(1, box.clientWidth / w))
      box.style.setProperty('--w', w + 'px')
      box.style.setProperty('--h', h + 'px')
      box.style.setProperty('--s', s)
      box.style.height = h * s + 'px'
    }
  }
  layout()
  new ResizeObserver(layout).observe(document.body)

  // the activity list of the MCP mockup
  const rows = [
    ['GIG-412', 'create_frame', 'Landing / Hero', 'Claude', '#0c8ce9', '0.4 s', 'now'],
    ['GIG-411', 'create_text', 'Breakfast, delivered warm.', 'Claude', '#0c8ce9', '0.2 s', '2 s'],
    ['GIG-410', 'update_node', 'Primary · cornerRadius 18', 'Codex', '#a98bff', '0.1 s', '5 s'],
    ['GIG-409', 'get_screenshot', 'Landing, 2x PNG', 'Claude', '#0c8ce9', '0.9 s', '9 s'],
    ['GIG-408', 'link_spec', 'Landing hero → Landing', 'Codex', '#a98bff', '0.1 s', '14 s'],
    ['GIG-407', 'apply_guideline', 'Sunrise → Landing', 'Claude', '#0c8ce9', '0.3 s', '21 s'],
  ]
  const done = [
    ['GIG-406', 'create_component', 'Button / Primary', 'Claude', '#0c8ce9', '0.5 s', '1 min'],
    ['GIG-405', 'set_auto_layout', 'Card / Product', 'Codex', '#a98bff', '0.2 s', '2 min'],
    ['GIG-404', 'export_node', 'Hero.svg', 'Claude', '#0c8ce9', '0.6 s', '3 min'],
  ]
  const row = ([id, tool, what, who, color, took, when], live) => `
    <div class="flex h-[34px] items-center gap-3 border-t border-white/5 px-3 text-[11px]">
      <span class="w-[52px] text-white/35">${id}</span>
      <span class="flex h-[14px] w-[14px] items-center justify-center rounded-full border ${live ? 'border-[#f5a524]' : 'border-[#22c55e] bg-[#22c55e]/20'}">${live ? '<span class="h-[6px] w-[6px] rounded-full bg-[#f5a524]"></span>' : ''}</span>
      <span class="font-mono text-[10.5px] text-white/90">${tool}</span>
      <span class="truncate text-white/45">${what}</span>
      <span class="ml-auto flex items-center gap-1.5 rounded-full bg-white/[0.06] px-2 py-[2px] text-[10px] text-white/75"><span class="h-[7px] w-[7px] rounded-full" style="background:${color}"></span>${who}</span>
      <span class="w-[36px] text-right text-white/35">${took}</span>
      <span class="w-[40px] text-right text-white/35">${when}</span>
      <span class="flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8px] font-bold text-white" style="background:${color}">${who[0]}</span>
    </div>`
  const list = document.getElementById('mcp-rows')
  if (list) list.innerHTML = rows.map((r) => row(r, true)).join('')
  const old = document.getElementById('mcp-done')
  if (old) old.innerHTML = done.map((r) => row(r, false)).join('')
  // the newest call slides in from time to time, as if an assistant is at work
  if (list && !calm) {
    const tools = [
      ['create_rect', 'Badge background'],
      ['update_text', 'Headline, weight 700'],
      ['create_frame', 'Pricing / Card'],
      ['get_layers', 'Page 1'],
      ['set_fill', 'Primary · #F97316'],
      ['create_ellipse', 'Avatar'],
    ]
    let n = 413
    setInterval(() => {
      const [tool, what] = tools[n % tools.length]
      const claude = n % 3 !== 1
      list.insertAdjacentHTML('afterbegin', row([`GIG-${n}`, tool, what, claude ? 'Claude' : 'Codex', claude ? '#0c8ce9' : '#a98bff', '0.2 s', 'now'], true))
      const first = list.firstElementChild
      first.animate([{ opacity: 0, transform: 'translateY(-8px)', background: 'rgba(12,140,233,0.18)' }, { opacity: 1, transform: 'none', background: 'transparent' }], { duration: 700, easing: 'cubic-bezier(0.2,0.7,0.2,1)' })
      list.lastElementChild.remove()
      n++
    }, 2600)
  }

  // things appear as they scroll into view
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('in')
        seen.unobserve(e.target)
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  )
  document.querySelectorAll('.reveal').forEach((el) => seen.observe(el))

  /**
   * The line of lightning between the two halves of the window on the first screen.
   * It glows quietly, and every second or two it strikes: a few jagged flashes that are drawn anew each time.
   */
  const bolt = document.getElementById('bolt')
  if (bolt) {
    const [b1, b2, b3] = bolt.querySelectorAll('path')
    const wrap = bolt.parentElement
    // a broken line from top to bottom, wandering up to `amp` px from the middle (less at the ends)
    const zig = (amp) => {
      const w = bolt.clientWidth
      const h = bolt.clientHeight
      let y = 0
      let d = `M${w / 2} 0`
      while (y < h) {
        y = Math.min(h, y + 8 + Math.random() * 30)
        const x = w / 2 + (Math.random() - 0.5) * 2 * amp * (0.25 + 0.75 * Math.sin((Math.PI * y) / h))
        d += `L${x.toFixed(1)} ${y.toFixed(1)}`
      }
      return d
    }
    const draw = () => {
      b1.setAttribute('d', zig(4))
      b2.setAttribute('d', zig(11))
      b3.setAttribute('d', zig(20))
    }
    draw()
    if (!calm) {
      const strike = () => {
        let n = 3 + Math.floor(Math.random() * 4)
        const flash = () => {
          draw()
          wrap.classList.add('strike')
          setTimeout(() => wrap.classList.remove('strike'), 45 + Math.random() * 50)
          if (--n > 0) setTimeout(flash, 70 + Math.random() * 110)
          else setTimeout(strike, 900 + Math.random() * 2200)
        }
        // nothing strikes in a tab nobody looks at
        if (document.visibilityState === 'visible') flash()
        else setTimeout(strike, 1500)
      }
      setTimeout(strike, 1200)
    }
    new ResizeObserver(draw).observe(bolt)
  }

  // the hand of the dial at the end sweeps slowly
  const hand = document.getElementById('hand')
  if (hand && !calm) {
    let a = -30
    setInterval(() => {
      a = a === -30 ? 40 : -30
      hand.animate([{ rotate: hand.style.rotate }, { rotate: a + 'deg' }], { duration: 2200, easing: 'cubic-bezier(0.65,0,0.35,1)', fill: 'forwards' })
      hand.style.rotate = a + 'deg'
    }, 3000)
  }

  // the promo video in a window
  const player = document.getElementById('player')
  const video = document.getElementById('player-video')
  const close = () => {
    player.classList.add('hidden')
    player.classList.remove('flex')
    video.pause()
  }
  document.querySelectorAll('[data-video]').forEach((b) =>
    b.addEventListener('click', () => {
      player.classList.remove('hidden')
      player.classList.add('flex')
      video.play().catch(() => {})
    })
  )
  document.getElementById('player-close').addEventListener('click', close)
  player.addEventListener('click', (e) => e.target === player && close())
  addEventListener('keydown', (e) => e.key === 'Escape' && close())
})()
