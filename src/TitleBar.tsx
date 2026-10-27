import { useEffect, useState } from 'react'
import { BookOpen, Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { service } from './service'

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!service.isDesktop) return
    const appWindow = getCurrentWindow()
    let alive = true
    const update = () => { void appWindow.isMaximized().then(value => { if (alive) setMaximized(value) }).catch(() => {}) }
    update()
    const listener = appWindow.onResized(update)
    return () => { alive = false; void listener.then(unlisten => unlisten()) }
  }, [])
  if (!service.isDesktop) return null
  const act = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void getCurrentWindow()[action]().catch(error => window.alert(`窗口操作失败：${String(error)}`))
  }
  return <header className="app-titlebar">
    <div className="titlebar-drag" data-tauri-drag-region><BookOpen size={16} /><span>作业簿</span></div>
    <div className="titlebar-controls"><button aria-label="最小化" onClick={() => act('minimize')}><Minus size={16} /></button><button aria-label={maximized ? '还原窗口' : '最大化'} onClick={() => act('toggleMaximize')}>{maximized ? <Copy size={14} /> : <Square size={14} />}</button><button className="window-close" aria-label="关闭窗口" onClick={() => act('close')}><X size={18} /></button></div>
  </header>
}
