// Only an appearance preference is cached; never credentials or account data.
(() => {
  const root = document.documentElement
  let theme
  try { theme = localStorage.getItem('homeworkbook:theme') } catch { /* Storage may be disabled. */ }
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const color = theme === 'dark' ? '#1b1b1d' : '#f0f3f8'
  root.dataset.theme = theme
  root.dataset.standalone = String(standalone)
  root.style.colorScheme = theme
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
  root.style.backgroundColor = color
  try { document.cookie = `homeworkbook_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}` } catch { /* Appearance works without cookies. */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
})()
