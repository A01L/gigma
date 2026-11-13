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
   * The task board of Gigma in the "Connect your AI" block. It is the page of the app rebuilt in HTML,
   * and it lives: an assistant takes a task from the queue, works on it, finishes it; the counters follow.
   * When everything is done the board starts over.
   */
  const board = document.getElementById('gapp-list')
  if (board) {
    const ICON = {
      IN_PROGRESS: '<svg class="gt-ico progress" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" /></svg>',
      TODO: '<svg class="gt-ico todo" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2.4 2.2"><circle cx="8" cy="8" r="6" /></svg>',
      DONE: '<svg class="gt-ico done" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6" fill="currentColor" fill-opacity="0.18" /><path d="M5.4 8.2l1.8 1.8 3.4-3.8" stroke-linecap="round" stroke-linejoin="round" /></svg>'
    }
    const GROUPS = [
      ['IN_PROGRESS', 'In progress'],
      ['TODO', 'Queue'],
      ['DONE', 'Done']
    ]
    // title, the start of the task text, the frame it is wired to, the project, status, the assistant
    const START = [
      ['Light theme', 'Same layout on a light background. Keep the violet accent.', 'Dashboard', 'Orbit Analytics', 'IN_PROGRESS', 'Codex'],
      ['Menu section', 'Six products in a grid: photo, name, price, an "add" button.', 'Landing', 'Sunrise Bakery', 'IN_PROGRESS', 'Claude'],
      ['Empty states', 'What the dashboard shows before the first data arrives.', 'Dashboard', 'Orbit Analytics', 'TODO', ''],
      ['Transfer confirmation', 'After "Send money": a receipt with the amount and a share button.', 'Transfer', 'Aurora Bank', 'TODO', ''],
      ['Bakers and their story', 'Three portraits with a short line each, on a cream background.', 'Landing', 'Sunrise Bakery', 'TODO', ''],
      ['Footer with newsletter', 'Address, hours, an email field and the logo.', 'Landing', 'Sunrise Bakery', 'TODO', ''],
      ['Mobile version', 'The same page at 390 px: one column, the collage under the headline.', 'Landing', 'Sunrise Bakery', 'TODO', ''],
      ['Revenue chart', 'Weekly bars, the last three weeks in violet.', 'Dashboard', 'Orbit Analytics', 'DONE', 'Claude'],
      ['Card details sheet', 'Bottom sheet over the Card screen: number, expiry, copy buttons.', 'Card', 'Aurora Bank', 'DONE', 'Claude'],
      ['Hero block', 'A warm headline, one orange button, a collage with an order card.', 'Landing', 'Sunrise Bakery', 'DONE', 'Claude']
    ]
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
    const heads = Object.fromEntries(
      GROUPS.map(([status, label]) => {
        const el = document.createElement('div')
        el.className = 'gt-head ' + status.toLowerCase()
        el.innerHTML = `<span class="gt-chev">▾</span>${label}<small></small>`
        return [status, el]
      })
    )
    let tasks = []
    const make = () => {
      board.textContent = ''
      tasks = START.map(([title, text, frame, project, status, who], i) => {
        const el = document.createElement('div')
        el.className = 'gt-row'
        el.innerHTML = `<span class="gt-st"></span><b>${esc(title)}</b><span class="gt-ex">${esc(text)}</span><span class="gt-chip">→ ${esc(frame)}</span><span class="gt-chip gt-ai"><i></i><u></u></span><span class="gt-chip">${esc(project)}</span><span class="gt-page">Page 1</span>`
        return { el, status, who, order: i }
      })
    }
    const set = (id, text) => (document.getElementById(id).textContent = text)
    let stamp = 100
    /** lay the rows out by status; `moved` is the task that has just changed, it gets a flash */
    const render = (moved) => {
      const scale = parseFloat(getComputedStyle(board.closest('.fit')).getPropertyValue('--s')) || 1
      const was = new Map([...board.children].map((el) => [el, el.getBoundingClientRect().top]))
      for (const [status] of GROUPS) {
        const rows = tasks.filter((t) => t.status === status).sort((a, b) => (status === 'DONE' ? b.order - a.order : a.order - b.order))
        const head = heads[status]
        head.hidden = !rows.length
        head.querySelector('small').textContent = `· ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`
        board.append(head)
        rows.forEach((t, i) => {
          t.el.className = 'gt-row ' + status.toLowerCase() + (i === rows.length - 1 ? ' last' : '')
          t.el.querySelector('.gt-st').innerHTML = ICON[status]
          const ai = t.el.querySelector('.gt-ai')
          ai.hidden = !t.who
          ai.dataset.who = t.who
          ai.querySelector('u').textContent = t.who
          board.append(t.el)
        })
      }
      const done = tasks.filter((t) => t.status === 'DONE').length
      const pct = Math.round((done / tasks.length) * 100) + '%'
      set('gapp-n', tasks.length)
      set('gapp-pct', pct)
      set('gapp-total', `${done} of ${tasks.length} done`)
      document.getElementById('gapp-bar').style.width = pct
      if (calm) return
      // every row glides from where it was to where it is now
      for (const el of board.children) {
        const from = was.get(el)
        if (from === undefined || el.hidden) continue
        const dy = (from - el.getBoundingClientRect().top) / scale
        if (Math.abs(dy) > 0.5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 620, easing: 'cubic-bezier(0.3, 0.8, 0.25, 1)' })
      }
      if (moved) {
        moved.el.style.zIndex = 2
        moved.el.animate([{ backgroundColor: 'rgba(13,153,255,0.32)' }, { backgroundColor: '#2c2c2c' }], { duration: 1100, easing: 'ease-out' }).onfinish = () => (moved.el.style.zIndex = '')
      }
    }
    make()
    render()
    if (!calm) {
      let turn = 0
      const step = () => {
        const doing = tasks.filter((t) => t.status === 'IN_PROGRESS').sort((a, b) => a.order - b.order)
        const queue = tasks.filter((t) => t.status === 'TODO').sort((a, b) => a.order - b.order)
        if (!doing.length && !queue.length) {
          // all done: a moment to look at it, then the board starts over
          make()
          render()
          return 2600
        }
        let t
        if (queue.length && (doing.length < 2 || (doing.length < 3 && Math.random() < 0.35))) {
          // an assistant takes the next task from the queue
          t = queue[0]
          t.status = 'IN_PROGRESS'
          t.who = turn++ % 2 ? 'Codex' : 'Claude'
        } else {
          // the one that has been in work the longest is finished
          t = doing[0]
          t.status = 'DONE'
        }
        t.order = stamp++
        render(t)
        return !tasks.some((x) => x.status !== 'DONE') ? 3600 : 1700 + Math.random() * 900
      }
      let seen = false
      let timer = 0
      const tick = () => {
        timer = 0
        if (!seen || document.visibilityState !== 'visible') return
        timer = setTimeout(tick, step())
      }
      const wake = () => {
        if (!timer && seen && document.visibilityState === 'visible') timer = setTimeout(tick, 1400)
      }
      new IntersectionObserver(
        ([e]) => {
          seen = e.isIntersecting
          wake()
        },
        { threshold: 0.25 }
      ).observe(board)
      document.addEventListener('visibilitychange', wake)
    }
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
