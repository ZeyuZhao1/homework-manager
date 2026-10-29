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
  // iOS derives its status-area background from the document canvas.
  document.body.style.backgroundColor = color
  // For browsers that support theme-color; this is not an iOS repaint mechanism.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
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
