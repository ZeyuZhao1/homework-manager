import { useSyncExternalStore } from 'react'

const enabledKey = 'homeworkbook:view:calendar-enabled'
const viewKey = 'homeworkbook:view:todo-layout'
const changed = 'homeworkbook:view-preference-changed'
function read(key: string) { try { return localStorage.getItem(key) } catch { return null } }
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === enabledKey || event.key === viewKey || event.key === null) listener() }
  window.addEventListener(changed, listener)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(changed, listener); window.removeEventListener('storage', storage) }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { throw new Error('无法保存视图偏好，请检查此设备的存储设置。') }
  window.dispatchEvent(new Event(changed))
}
export function useCalendarEnabled() { return useSyncExternalStore(subscribe, () => read(enabledKey) === 'true', () => false) }
export function setCalendarEnabled(enabled: boolean) { write(enabledKey, String(enabled)) }
export function useTodoLayout() { return useSyncExternalStore(subscribe, () => read(viewKey) === 'list' ? 'list' : 'calendar', () => 'calendar') }
export function setTodoLayout(layout: 'list' | 'calendar') { write(viewKey, layout) }
