import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { service } from './service'
import type { MacosChromeState } from './types'

type ChromeAction = { action: string; value: string; searchReset?: number }
const eventName = 'homeworkbook:macos-chrome-action'
const modalSelector = '[aria-modal="true"]:not([hidden])'

function useModalState() {
  const [blocked, setBlocked] = useState(false)
  useLayoutEffect(() => {
    if (!service.isMacDesktop) return
    const update = () => setBlocked(!!document.querySelector(modalSelector))
    const observer = new MutationObserver(update)
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal', 'hidden'],
    })
    update()
    return () => observer.disconnect()
  }, [])
  return blocked
}

export function useMacosChrome(state: Omit<MacosChromeState, 'blocked'> | null, onAction: (event: ChromeAction) => void) {
  const [installed, setInstalled] = useState(false)
  const blocked = useModalState()
  const latestAction = useRef(onAction)
  const queue = useRef(Promise.resolve())

  useLayoutEffect(() => {
    latestAction.current = onAction
  }, [onAction])

  useEffect(() => {
    if (!service.isMacDesktop) return
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ChromeAction>).detail
      if (typeof detail?.action === 'string' && typeof detail.value === 'string' && !document.querySelector(modalSelector)) {
        latestAction.current(detail)
      }
    }
    window.addEventListener(eventName, listener)
    return () => window.removeEventListener(eventName, listener)
  }, [])

  useLayoutEffect(() => {
    if (!service.isMacDesktop || !state) return
    let current = true
    // A slow AppKit update must finish before the next state can reach the UI.
    // Skip queued states that have already been superseded by a React commit.
    queue.current = queue.current.then(async () => {
      if (!current) return
      try {
        const active = await service.updateMacosChrome({ ...state, blocked })
        if (current) setInstalled(active)
      } catch (error) {
        if (current) console.warn('无法同步 macOS 原生导航', error)
      }
    })
    return () => { current = false }
  }, [state, blocked])
  return installed
}
