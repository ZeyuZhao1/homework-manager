import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen } from 'lucide-react'
import { service } from './service'
import type { FileAsset } from './types'

export function FileContextMenu({ file, className, children }: { file?: FileAsset; className: string; children: ReactNode }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!position) return
    itemRef.current?.focus()
    const dismiss = () => setPosition(null)
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) dismiss()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
        previousFocus.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [position])

  const show = (x: number, y: number) => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - 228)), y: Math.max(8, Math.min(y, window.innerHeight - 56)) })
  }

  return <div className={className} tabIndex={file ? 0 : undefined}
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
    {position ? createPortal(<div ref={menuRef} className="file-context-menu" role="menu" aria-label="关联文件操作"
      style={{ left: position.x, top: position.y }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPosition(null) }}
      onKeyDown={event => {
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          itemRef.current?.focus()
        }
      }}>
      <button ref={itemRef} role="menuitem" onClick={() => {
        setPosition(null)
        previousFocus.current?.focus()
        if (file) void service.openFileDirectory(file.id).catch(error => window.alert(`打开所在文件夹失败：${error instanceof Error ? error.message : String(error)}`))
      }}><FolderOpen size={16} />打开所在文件夹</button>
    </div>, document.body) : null}
  </div>
}
