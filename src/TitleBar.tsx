import { useEffect, useState } from 'react'
import { BookOpen, Minus, Square, Copy, X } from 'lucide-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { service } from './service'

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const [nativeControls, setNativeControls] = useState<boolean | null>(null)
  useEffect(() => {
    if (!service.isDesktop) return
    const appWindow = getCurrentWindow()
    let alive = true
    void appWindow.isDecorated().then(value => { if (alive) setNativeControls(value) }).catch(() => { if (alive) setNativeControls(false) })
    let updating = false
    let updateQueued = false
    const update = () => {
      if (!alive) return
      if (updating) { updateQueued = true; return }
      updating = true
      void appWindow.isMaximized().then(value => { if (alive) setMaximized(value) }).catch(() => {}).finally(() => {
        updating = false
        if (updateQueued) { updateQueued = false; update() }
      })
    }
    update()
    const listener = appWindow.onResized(update).catch(() => undefined)
    return () => { alive = false; void listener.then(unlisten => unlisten?.()).catch(() => {}) }
  }, [])
  if (!service.isDesktop) return null
  const act = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    void getCurrentWindow()[action]().catch(error => window.alert(`窗口操作失败：${String(error)}`))
  }
  return <header className={`app-titlebar ${nativeControls ? 'native-controls' : ''}`}>
    <div className="titlebar-drag" data-tauri-drag-region><BookOpen size={16} data-tauri-drag-region /><span data-tauri-drag-region>作业簿</span></div>
    {nativeControls === false ? <div className="titlebar-controls"><button title="最小化" aria-label="最小化" onClick={() => act('minimize')}><Minus size={16} /></button><button title={maximized ? '还原窗口' : '最大化'} aria-label={maximized ? '还原窗口' : '最大化'} onClick={() => act('toggleMaximize')}>{maximized ? <Copy size={14} /> : <Square size={14} />}</button><button className="window-close" title="关闭窗口" aria-label="关闭窗口" onClick={() => act('close')}><X size={18} /></button></div> : null}
  </header>
}
