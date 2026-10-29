/** Keep document chrome stationary; only the app's intended panes scroll. */
export function installMobileViewport() {
  const root = document.documentElement
  const small = matchMedia('(max-width: 780px)')
  const touchInput = matchMedia('(pointer: coarse)')
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  const viewport = document.querySelector('meta[name="viewport"]')
  const previousViewport = viewport?.getAttribute('content')
  if (standalone) viewport?.setAttribute('content', 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content')
  const visual = window.visualViewport
  let frame = 0, x = 0, y = 0, restingHeight = innerHeight
  let orientation = screen.orientation?.type
  let layoutWidth = innerWidth
  const measure = () => {
    frame = 0
    if (!small.matches) {
      root.style.removeProperty('--app-viewport-height'); root.style.removeProperty('--app-viewport-top'); delete root.dataset.keyboard
      return
    }
    // Pinch zoom magnifies the existing canvas without reflow.
    if (visual && Math.abs(visual.scale - 1) > .01) return
    if (orientation !== screen.orientation?.type || layoutWidth !== innerWidth) { orientation = screen.orientation?.type; layoutWidth = innerWidth; restingHeight = innerHeight }
    const height = visual?.height || innerHeight
    restingHeight = Math.max(restingHeight, innerHeight, height)
    root.style.setProperty('--app-viewport-height', `${height}px`)
    root.style.setProperty('--app-viewport-top', `${visual?.offsetTop || 0}px`)
    const editing = document.activeElement?.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]')
    root.dataset.keyboard = touchInput.matches && editing && restingHeight - height > 120 ? 'open' : 'closed'
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
  const mediaChange = () => { restingHeight = innerHeight; schedule() }
  const preventGesture = (event: Event) => { if (event.cancelable) event.preventDefault() }
  const start = (event: TouchEvent) => { const touch = event.touches[0]; if (touch) { x = touch.clientX; y = touch.clientY } }
  const move = (event: TouchEvent) => {
    if (event.touches.length > 1) return
    if (!small.matches || !event.touches.length || !standalone && visual && visual.scale > 1.01) return
    const touch = event.touches[0], dx = touch.clientX - x, dy = touch.clientY - y
    x = touch.clientX; y = touch.clientY
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 1) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"], [data-native-gesture]') || window.getSelection()?.isCollapsed === false) return
    const vertical = Math.abs(dy) >= Math.abs(dx), delta = vertical ? dy : dx
    for (let node = target; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (!/auto|scroll/.test(vertical ? style.overflowY : style.overflowX)) continue
      const extent = vertical ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth
      const offset = vertical ? node.scrollTop : node.scrollLeft
      if (extent > 1 && (delta > 0 ? offset > 0 : offset < extent - 1)) return
      if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') break
    }
    // Prevent rubber-banding the document or dragging the complete modal at an edge.
    preventGesture(event)
  }
  measure()
  visual?.addEventListener('resize', schedule); visual?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule); window.addEventListener('focusin', schedule); window.addEventListener('focusout', schedule); small.addEventListener('change', mediaChange)
  document.addEventListener('touchstart', start, { passive: true, capture: true })
  document.addEventListener('touchmove', move, { passive: false, capture: true })


  return () => {
    cancelAnimationFrame(frame)
    if (previousViewport !== null && previousViewport !== undefined) viewport?.setAttribute('content', previousViewport)
    visual?.removeEventListener('resize', schedule); visual?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule); window.removeEventListener('focusin', schedule); window.removeEventListener('focusout', schedule); small.removeEventListener('change', mediaChange)
    document.removeEventListener('touchstart', start, true); document.removeEventListener('touchmove', move, true)
    if (standalone) for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.removeEventListener(type, preventGesture)
  }
}
