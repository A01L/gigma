// Behaviour of the landing page. No libraries: plain DOM.
(() => {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches

  // the bar gets a backdrop once the page is scrolled
  const nav = document.getElementById('nav')
  const onScroll = () => {
    const on = scrollY > 24
    nav.classList.toggle('bg-ink/75', on)
    nav.classList.toggle('backdrop-blur-xl', on)
    nav.classList.toggle('border-b', on)
    nav.classList.toggle('border-white/10', on)
  }
  addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  // things appear as they scroll into view; counters start with them
  const count = (el) => {
    const to = +el.dataset.count
    const t0 = performance.now()
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 1400)
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)))
      if (p < 1) requestAnimationFrame(step)
    }
    calm ? (el.textContent = to) : requestAnimationFrame(step)
  }
  const seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add('in-view')
        e.target.querySelectorAll('[data-count]').forEach(count)
        seen.unobserve(e.target)
      }
    },
    { threshold: 0.18 }
  )
  document.querySelectorAll('.reveal').forEach((el) => seen.observe(el))

  // a light under the pointer on the feature cards
  document.querySelectorAll('.card').forEach((card) =>
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect()
      card.style.setProperty('--mx', e.clientX - r.left + 'px')
      card.style.setProperty('--my', e.clientY - r.top + 'px')
    })
  )

  // copy the address of the MCP server
  const copy = document.getElementById('copy')
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById('mcp-url').textContent)
      copy.textContent = 'Copied'
    } catch {
      copy.textContent = 'Select it'
    }
    setTimeout(() => (copy.textContent = 'Copy'), 1600)
  })

  /**
   * An AI cursor that lands on one spot after another (it never travels, as in the app).
   * spots: [left %, top %]
   */
  function hop(el, spots, every) {
    if (!el || calm) return
    let i = 0
    setInterval(() => {
      i = (i + 1) % spots.length
      el.style.left = spots[i][0] + '%'
      el.style.top = spots[i][1] + '%'
      el.classList.remove('land')
      void el.offsetWidth
      el.classList.add('land')
    }, every)
  }
  // first screen: Claude works through the landing page in the screenshot, the user's pointer strolls next to it
  hop(document.getElementById('hero-ai'), [[40, 40], [36, 52], [41, 70], [58, 57], [61, 28], [50, 44]], 1500)
  const user = document.getElementById('hero-user')
  if (user && !calm) {
    const path = [[52, 80], [47, 49], [57, 62], [66, 44], [44, 62]]
    let k = 0
    setInterval(() => {
      k = (k + 1) % path.length
      user.style.left = path[k][0] + '%'
      user.style.top = path[k][1] + '%'
    }, 2300)
  }
  hop(document.querySelector('#card-cursor .cur-ai'), [[40, 34], [58, 62], [78, 50], [30, 60]], 1300)

  // the "bytes uploaded" counter stays at zero, on purpose: it flickers and comes back
  const bytes = document.getElementById('bytes')
  if (bytes && !calm)
    setInterval(() => {
      bytes.style.opacity = 0.35
      setTimeout(() => (bytes.style.opacity = 1), 180)
    }, 2600)
})()
