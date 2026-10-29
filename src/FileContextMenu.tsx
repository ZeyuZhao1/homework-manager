import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, MoreHorizontal } from 'lucide-react'
import { service } from './service'
import type { FileAsset } from './types'

export function FileContextMenu({ file, className, children, menuItems }: { file?: FileAsset; className: string; children: ReactNode; menuItems?: ReactNode }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!position || !menu) return
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - bounds.height - 8))}px`
  }, [position])

  useEffect(() => {
    if (!position) return
    itemRef.current?.focus({ preventScroll: true })
    const dismiss = () => setPosition(null)
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) dismiss()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        dismiss()
        previousFocus.current?.focus()
      }
    }
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      dismiss()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [position])

  const show = (x: number, y: number) => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPosition({ x, y })
  }

  return <div className={className} tabIndex={file ? 0 : undefined} aria-haspopup={file ? 'menu' : undefined}
    onContextMenu={event => {
      if (!file) return
      event.preventDefault()
      event.stopPropagation()
      show(event.clientX, event.clientY)
    }}
    onKeyDown={event => {
      if (!file || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      const bounds = event.currentTarget.getBoundingClientRect()
      show(bounds.left, bounds.bottom)
    }}>
    {children}
    {file ? <button type="button" className="icon-button tiny file-menu-trigger" aria-label="文件操作" title="文件操作" aria-haspopup="menu" aria-expanded={!!position} onClick={event => {
      event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
      const bounds = event.currentTarget.getBoundingClientRect()
      show(bounds.left, bounds.bottom)
    }}><MoreHorizontal size={17} /></button> : null}
    {position ? createPortal(<div ref={menuRef} className="file-context-menu" role="menu" aria-label="关联文件操作"
      style={{ left: position.x, top: position.y, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100dvh - 16px)', overflowY: 'auto' }}
      onClick={event => { event.stopPropagation(); previousFocus.current?.focus({ preventScroll: true }); setPosition(null) }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPosition(null) }}
      onKeyDown={event => {
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])
          const current = items.indexOf(document.activeElement as HTMLButtonElement)
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
          items[index]?.focus()
        }
      }}>
      <button ref={itemRef} role="menuitem" onClick={() => {
        setPosition(null)
        previousFocus.current?.focus()
        if (file) void service.openFileDirectory(file.id).catch(error => window.alert(`打开所在文件夹失败：${error instanceof Error ? error.message : String(error)}`))
      }}><FolderOpen size={16} />打开所在文件夹</button>
      {menuItems}
    </div>, document.body) : null}
  </div>
}
