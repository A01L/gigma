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
