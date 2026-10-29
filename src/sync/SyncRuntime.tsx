import { useEffect } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { desktopSync } from './desktop'
import { createSyncRunner } from './runner'

export function SyncRuntime() {
  useEffect(() => {
    if (!isTauri()) return
    const runner = createSyncRunner(desktopSync, () => window.dispatchEvent(new Event('homeworkbook:sync-refreshed')))
    const tick = () => { void runner.tick() }
    tick()
    const timer = window.setInterval(tick, 15000)
    window.addEventListener('focus', tick)
    window.addEventListener('online', tick)
    window.addEventListener('homeworkbook:sync-settings-changed', tick)
    window.addEventListener('homeworkbook:local-data-changed', tick)
    return () => {
      runner.stop()
      window.clearInterval(timer)
      window.removeEventListener('focus', tick)
      window.removeEventListener('online', tick)
      window.removeEventListener('homeworkbook:sync-settings-changed', tick)
      window.removeEventListener('homeworkbook:local-data-changed', tick)
    }
  }, [])
  return null
}
