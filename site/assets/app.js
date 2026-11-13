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
   * The line of light between the two halves of the window on the first screen:
   * small sparks drift slowly down along it, each swaying a little and glimmering.
   */
  const stream = document.getElementById('stream')
  if (stream) {
    const ctx = stream.getContext('2d')
    // one soft spark, drawn once and stamped for every particle
    const dot = document.createElement('canvas')
    dot.width = dot.height = 32
    const dctx = dot.getContext('2d')
    const glow = dctx.createRadialGradient(16, 16, 0, 16, 16, 16)
    glow.addColorStop(0, 'rgba(255,255,255,1)')
    glow.addColorStop(0.25, 'rgba(190,215,255,0.8)')
    glow.addColorStop(0.6, 'rgba(110,140,255,0.22)')
    glow.addColorStop(1, 'rgba(110,140,255,0)')
    dctx.fillStyle = glow
    dctx.fillRect(0, 0, 32, 32)

    let W = 0
    let H = 0
    let sparks = []
    const size = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2)
      W = stream.clientWidth
      H = stream.clientHeight
      stream.width = Math.round(W * dpr)
      stream.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // about one spark every 9 px of the line; most of them keep close to it
      const n = Math.max(14, Math.round(H / 9))
      sparks = Array.from({ length: n }, () => {
        const near = Math.random() < 0.7
        return {
          y: Math.random() * H,
          v: 5 + Math.random() * 22, // px a second: slow
          off: (Math.random() - 0.5) * (near ? 5 : 22), // how far from the line it floats
          sway: 1 + Math.random() * (near ? 2 : 6),
          r: (near ? 1.6 : 1) + Math.random() * 2.4,
          a: near ? 0.5 + Math.random() * 0.5 : 0.18 + Math.random() * 0.3,
          ph: Math.random() * 6.28,
          tw: 0.4 + Math.random() * 1.1
        }
      })
    }
    const paint = (t, dt) => {
      ctx.clearRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      for (const p of sparks) {
        p.y += p.v * dt
        if (p.y > H) p.y -= H
        const x = W / 2 + p.off + Math.sin(t * 0.5 + p.ph) * p.sway
        // sparks are born and fade inside the window: nothing sticks out past its edges
        const edge = Math.min(1, p.y / 36, (H - p.y) / 36)
        ctx.globalAlpha = Math.max(0, p.a * edge * (0.55 + 0.45 * Math.sin(t * p.tw + p.ph)))
        const d = p.r * 4
        ctx.drawImage(dot, x - d / 2, p.y - d / 2, d, d)
      }
      ctx.globalAlpha = 1
    }
    size()
    new ResizeObserver(() => {
      size()
      paint(0, 0)
    }).observe(stream)
    paint(0, 0)
    if (!calm) {
      let seen = true
      let running = false
      let last = 0
      const frame = (now) => {
        if (!seen || document.visibilityState !== 'visible') {
          running = false
          last = 0
          return
        }
        requestAnimationFrame(frame)
        const dt = Math.min(0.05, last ? (now - last) / 1000 : 0)
        last = now
        paint(now / 1000, dt)
      }
      const run = () => {
        if (running || !seen || document.visibilityState !== 'visible') return
        running = true
        requestAnimationFrame(frame)
      }
      new IntersectionObserver(([e]) => {
        seen = e.isIntersecting
        run()
      }).observe(stream)
      document.addEventListener('visibilitychange', run)
      run()
    }
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
