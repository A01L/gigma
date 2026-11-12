// run in #shell: close and trash every open test project tab
(async () => {
  const st = await gigma.tabs.state()
  const done = []
  for (const t of st.tabs) {
    if (!/test/i.test(t.title ?? t.name ?? '')) continue
    await gigma.tabs.close(t.id)
    if (t.path) await gigma.library.trash(t.path)
    done.push(t.title ?? t.name)
  }
  return JSON.stringify({ done, keys: st.tabs[0] ? Object.keys(st.tabs[0]) : [] })
})()
