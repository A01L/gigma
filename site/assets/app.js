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

  /**
   * The waterfall of light on the first screen. Light pours down onto the top edge of the mockup,
   * spreads along it like water on a table, runs to the right corner and falls off the edge.
   * Every streak is a particle that follows that path; the canvas is faded a little each frame, so streaks leave tails.
   */
  const box = document.getElementById('hero-box')
  const cv = document.getElementById('fall')
  const glow = document.getElementById('fall-glow')
  if (box && cv && glow && !calm) {
    const ctx = cv.getContext('2d')
    const gctx = glow.getContext('2d')
    const PAD_L = 160 // room for the spray on the left
    const PAD_R = 200 // and for the fall past the right edge
    const G = 1150 // gravity, px/s²
    let W = 0
    let H = 0
    let dpr = 1
    let cx = 0 // where the water comes down
    let plate = 0 // y of the top edge of the mockup
    let right = 0 // x of its right edge
    let side = 0 // how far the water falls along the right edge
    let fadeTop = false // the stream starts in mid-air (narrow screens): let it fade in
    let k = 1 // everything is smaller on a small mockup
    const size = () => {
      const sec = box.closest('section').getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const beam = box.querySelector('.beam')
      const max = beam ? parseFloat(getComputedStyle(beam).height) || 1100 : 1100
      const above = Math.round(Math.min(b.top - sec.top, max))
      fadeTop = above < b.top - sec.top - 2
      W = Math.round(b.width + PAD_L + PAD_R)
      H = Math.round(above + b.height)
      dpr = Math.min(devicePixelRatio || 1, 1.5)
      for (const c of [cv, glow]) {
        c.style.left = -PAD_L + 'px'
        c.style.top = -above + 'px'
        c.style.width = W + 'px'
        c.style.height = H + 'px'
      }
      cv.width = Math.round(W * dpr)
      cv.height = Math.round(H * dpr)
      // the glow is the same picture six times smaller: stretched back, it comes out soft.
      // (a CSS blur on a canvas this size costs most of the frame on machines without a fast GPU)
      glow.width = Math.round(W / 6)
      glow.height = Math.round(H / 6)
      cx = PAD_L + b.width * 0.7
      plate = above
      right = PAD_L + b.width
      side = b.height * 0.82
      k = Math.max(0.45, Math.min(1, b.width / 900))
    }
    size()
    new ResizeObserver(size).observe(box)
    box.classList.add('flowing')

    const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 1.15
    let parts = []
    let drops = []
    const spawn = () => {
      // three layers: the bright heart, the body around it, and thin spray outside
      const pick = Math.random()
      const layer = pick < 0.42 ? 0 : pick < 0.8 ? 1 : 2
      const o = (gauss() * [2.6, 8, 20][layer] + 0.8) * k // a touch more of it goes right, to the corner
      parts.push({
        st: 0, // 0 falling, 1 turning on the plate, 2 running along the edge, 3 falling off the right edge
        o,
        dir: o > 0 ? 1 : -1,
        x: cx + o * 0.5,
        bx: 0, // where it left the vertical
        y: -Math.random() * 80,
        v: 360 + Math.random() * 460,
        R: 16 * k + Math.abs(o) * 7 + Math.random() * 14 * k, // outer layers turn in a wider curve: together they make the horn
        h: 0.4 + Math.abs(o) * 0.2 + Math.random() * 1.6, // and run higher above the edge
        a: [0.35 + Math.random() * 0.6, 0.14 + Math.random() * 0.36, 0.08 + Math.random() * 0.16][layer],
        w: [1.5, 1.1, 0.8][layer],
        ang: 0,
        j: Math.random() * 5, // its own lane when it falls off the corner
        layer
      })
    }
    const step = (p, dt) => {
      if (p.st === 0) {
        p.v = Math.min(p.v + G * dt, 1500)
        p.y += p.v * dt
        // the stream is thin at the top and opens up on the way down
        p.x = cx + p.o * (0.5 + 0.7 * Math.min(1, Math.max(0, p.y) / plate))
        const turn = plate - p.h - p.R
        if (p.y >= turn) {
          p.st = 1
          p.bx = p.x
          p.ang = (p.y - turn) / p.R
        } else return true
      }
      if (p.st === 1) {
        p.ang += (p.v * dt) / p.R
        if (p.ang < Math.PI / 2) {
          p.x = p.bx + p.dir * p.R * (1 - Math.cos(p.ang))
          p.y = plate - p.h - p.R + p.R * Math.sin(p.ang)
          return true
        }
        p.st = 2
        p.x = p.bx + p.dir * p.R
        p.y = plate - p.h
        p.v *= 0.5
        // a little of it bounces off as spray
        if (Math.random() < 0.05)
          drops.push({ x: p.x, y: plate - 2, vx: p.dir * (40 + Math.random() * 220), vy: -(40 + Math.random() * 170), a: 0.3 + Math.random() * 0.3 })
        return true
      }
      if (p.st === 2) {
        p.v = Math.max(230, p.v - 520 * dt)
        p.x += p.dir * p.v * dt
        p.a *= Math.exp(-dt * (p.dir > 0 ? 0.45 : 2.6))
        if (p.dir > 0 && p.x >= right) {
          p.st = 3
          p.x = right + 1 + p.h * 0.8 + p.j
          p.y = plate
          p.v = Math.max(p.v * 0.55, 150)
          p.a = Math.min(1, p.a * 1.5) // it gathers at the corner before it drops
        }
        return p.a > 0.015 && p.x > 0
      }
      p.v = Math.min(p.v + G * 0.8 * dt, 1300)
      p.y += p.v * dt
      p.a *= Math.exp(-dt * 1.05)
      return p.a > 0.015 && p.y < plate + side
    }

    let on = true
    let seen = true
    let last = 0
    let running = false
    let debt = 0
    const frame = (now) => {
      if (!on || !seen) {
        running = false
        last = 0
        return
      }
      requestAnimationFrame(frame)
      const dt = Math.min(0.04, last ? (now - last) / 1000 : 0.016)
      last = now
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // older light fades: that is what draws the tails
      ctx.globalCompositeOperation = 'destination-out'
      ctx.globalAlpha = 1
      ctx.fillStyle = 'rgba(0,0,0,0.14)'
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      // the body of the stream, always there
      const core = ctx.createLinearGradient(0, 0, 0, plate)
      core.addColorStop(0, fadeTop ? 'rgba(200,220,255,0)' : 'rgba(200,220,255,0.05)')
      core.addColorStop(0.35, 'rgba(225,235,255,0.05)')
      core.addColorStop(1, 'rgba(255,255,255,0.09)')
      ctx.fillStyle = core
      ctx.fillRect(cx - 1.5, 0, 3, plate)
      // the horn where it lands: light piles up before it spreads
      const horn = ctx.createRadialGradient(cx, plate, 0, cx, plate, 210 * k)
      horn.addColorStop(0, 'rgba(255,255,255,0.075)')
      horn.addColorStop(0.3, 'rgba(190,210,255,0.035)')
      horn.addColorStop(1, 'rgba(110,130,255,0)')
      ctx.fillStyle = horn
      ctx.beginPath()
      ctx.moveTo(cx - 3 * k, plate - 250 * k)
      ctx.quadraticCurveTo(cx - 12 * k, plate - 24 * k, cx - 210 * k, plate - 1)
      ctx.lineTo(cx + 210 * k, plate - 1)
      ctx.quadraticCurveTo(cx + 12 * k, plate - 24 * k, cx + 3 * k, plate - 250 * k)
      ctx.fill()
      // the film of light that runs along the top edge to the corner
      const film = ctx.createLinearGradient(cx - 260, 0, right, 0)
      film.addColorStop(0, 'rgba(160,190,255,0)')
      film.addColorStop(Math.min(0.9, 260 / (right - cx + 260)), 'rgba(255,255,255,0.11)')
      film.addColorStop(1, 'rgba(215,205,255,0.06)')
      ctx.fillStyle = film
      ctx.fillRect(cx - 260, plate - 3, right - cx + 260, 3)
      // and the sheet that drops from the corner
      const sheet = ctx.createLinearGradient(0, plate, 0, plate + side)
      sheet.addColorStop(0, 'rgba(235,225,255,0.08)')
      sheet.addColorStop(0.5, 'rgba(180,150,255,0.035)')
      sheet.addColorStop(1, 'rgba(140,120,255,0)')
      ctx.fillStyle = sheet
      ctx.fillRect(right, plate - 2, 6, side)

      debt += dt * (W < 700 ? 170 : 320)
      while (debt >= 1) {
        debt--
        spawn()
      }
      // three small steps a frame keep the curves round
      const sub = 3
      const next = []
      for (const p of parts) {
        let alive = true
        ctx.lineWidth = p.w
        ctx.strokeStyle = p.st === 3 ? '#d6c6ff' : ['#ffffff', '#c3d5ff', '#86a8ff'][p.layer]
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        for (let i = 0; i < sub && alive; i++) {
          const was = p.st
          alive = step(p, dt / sub)
          if (was === 2 && p.st === 3) ctx.lineTo(right + 0.5, plate - p.h) // round the corner
          ctx.lineTo(p.x, p.y)
        }
        // on narrow screens the stream starts in mid-air: it comes out of nothing
        // and what falls off the corner thins out on the way down
        ctx.globalAlpha = p.a * (p.st === 3 ? Math.max(0, 1 - (p.y - plate) / side) ** 1.4 : fadeTop && p.st === 0 ? Math.min(1, p.y / 160) : 1)
        ctx.stroke()
        if (alive) next.push(p)
      }
      parts = next
      // spray
      ctx.strokeStyle = '#dfe9ff'
      ctx.lineWidth = 1.1
      drops = drops.filter((d) => {
        const x0 = d.x
        const y0 = d.y
        d.vy += 900 * dt
        d.x += d.vx * dt
        d.y += d.vy * dt
        d.a *= Math.exp(-dt * 2.4)
        ctx.globalAlpha = d.a
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(d.x, d.y)
        ctx.stroke()
        return d.a > 0.03 && d.y < plate
      })
      ctx.globalAlpha = 1
      // the glow: the same picture, small (drawn twice, so it is brighter than the streaks it comes from)
      gctx.imageSmoothingQuality = 'high'
      gctx.globalCompositeOperation = 'copy'
      gctx.drawImage(cv, 0, 0, glow.width, glow.height)
      gctx.globalCompositeOperation = 'lighter'
      gctx.drawImage(cv, 0, 0, glow.width, glow.height)
    }
    const run = () => {
      if (!on || !seen || running) return
      running = true
      requestAnimationFrame(frame)
    }
    new IntersectionObserver(([e]) => {
      seen = e.isIntersecting
      run()
    }).observe(box.closest('section'))
    document.addEventListener('visibilitychange', () => {
      on = document.visibilityState === 'visible'
      run()
    })
    run()
  }

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

  // first screen: Claude lands on one layer after another (it never travels, as in the app)
  const ai = document.getElementById('hero-ai')
  if (ai && !calm) {
    const spots = [
      [400, 236],
      [262, 196],
      [300, 290],
      [470, 196],
      [550, 500],
      [290, 492],
    ]
    let i = 0
    setInterval(() => {
      i = (i + 1) % spots.length
      ai.style.left = spots[i][0] + 'px'
      ai.style.top = spots[i][1] + 'px'
      ai.classList.remove('land')
      void ai.offsetWidth
      ai.classList.add('land')
    }, 1700)
  }

  // the user drags the order card back and forth
  const card = document.getElementById('drag-card')
  const user = document.getElementById('hero-user')
  if (card && user && !calm) {
    const stops = [
      { card: [392, 214, -5], hand: [470, 244] },
      { card: [470, 300, 3], hand: [548, 330] },
      { card: [430, 140, -2], hand: [508, 170] },
    ]
    let k = 0
    setInterval(() => {
      k = (k + 1) % stops.length
      const s = stops[k]
      card.style.left = s.card[0] + 'px'
      card.style.top = s.card[1] + 'px'
      card.style.rotate = s.card[2] + 'deg'
      user.style.left = s.hand[0] + 'px'
      user.style.top = s.hand[1] + 'px'
    }, 2400)
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
