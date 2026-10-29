import type { Theme } from './types'

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  const color = theme === 'dark' ? '#1b1b1d' : '#f0f3f8'
  root.dataset.theme = theme
  root.style.colorScheme = theme
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme)
  root.style.backgroundColor = color
  document.querySelector('link[rel="manifest"]')?.setAttribute('href', `/manifest.webmanifest?theme=${theme}&v=4`)
  try { document.cookie = `homeworkbook_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}` } catch { /* Appearance also works with cookies disabled. */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
  try { localStorage.setItem('homeworkbook:theme', theme) } catch { /* The app also works with storage disabled. */ }
}
