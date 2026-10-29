import type { Theme } from './types'

let preference: Theme = 'system'
let systemAppearance: MediaQueryList | undefined

function paintTheme() {
  const theme = preference === 'system' ? systemAppearance?.matches ? 'dark' : 'light' : preference
  const root = document.documentElement
  const color = theme === 'dark' ? '#1b1b1d' : '#f0f3f8'
  root.dataset.theme = theme
  root.dataset.themePreference = preference
  root.style.colorScheme = theme
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
  root.style.backgroundColor = color
  // The page canvas paints the transparent iOS status area too.
  document.body.style.backgroundColor = color
  // Replace the node to invalidate WebKit's cached browser-chrome color.
  const previous = document.querySelector('meta[name="theme-color"]')
  const meta = document.createElement('meta')
  meta.name = 'theme-color'; meta.content = color
  if (previous) previous.replaceWith(meta)
  else document.head.append(meta)
  try { document.cookie = `homeworkbook_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}` } catch { /* Appearance also works with cookies disabled. */ }
}

export function applyTheme(theme: Theme) {
  preference = ['light', 'dark', 'system'].includes(theme) ? theme : 'system'
  if (!systemAppearance) {
    systemAppearance = matchMedia('(prefers-color-scheme: dark)')
    systemAppearance.addEventListener('change', () => { if (preference === 'system') paintTheme() })
    window.addEventListener('pageshow', paintTheme)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) paintTheme() })
  }
  paintTheme()
  try { localStorage.setItem('homeworkbook:theme', preference) } catch { /* Storage is optional. */ }
}
