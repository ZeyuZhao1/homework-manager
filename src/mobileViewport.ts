/** Keep document chrome stationary; only the app's intended panes scroll. */
export function installMobileViewport() {
  const root = document.documentElement
  const small = matchMedia('(max-width: 780px)')
  const touchInput = matchMedia('(pointer: coarse)')
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  const viewport = document.querySelector('meta[name="viewport"]')
  const previousViewport = viewport?.getAttribute('content')
  const visual = window.visualViewport
  let frame = 0, x = 0, y = 0
  let restingHeight = innerHeight
  let layoutWidth = innerWidth
  let orientation = screen.orientation?.type
  let keyboardOpen = false
  let active = true
  const settling = new Set<number>()
  const isEditing = () => document.activeElement?.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="file"]):not([type="range"]):not([type="color"]), textarea, [contenteditable="true"]')
  const zoomPolicy = () => {
    if (touchInput.matches) viewport?.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content')
    else if (previousViewport != null) viewport?.setAttribute('content', previousViewport)
  }
  const clearGeometry = () => {
    root.style.removeProperty('--app-viewport-height')
    root.style.removeProperty('--app-viewport-top')
    root.dataset.keyboard = 'closed'
  }
  const measure = () => {
    frame = 0
    if (!active) return
    zoomPolicy()
    const scale = visual?.scale || 1
    // CSS geometry is in layout pixels. Auto-zoom must not freeze the previous
    // keyboard height or be mistaken for a newly opened keyboard.
    const height = (visual?.height || innerHeight) * scale
    if (orientation !== screen.orientation?.type || layoutWidth !== innerWidth) {
      orientation = screen.orientation?.type; layoutWidth = innerWidth
      restingHeight = Math.max(innerHeight, root.clientHeight, height)
    }
    const editing = !!isEditing()
    // Preserve the same-orientation baseline through blur/refocus while a
    // resizes-content keyboard still shrinks every viewport measurement.
    restingHeight = Math.max(restingHeight, innerHeight, root.clientHeight, height)
    const gap = restingHeight - height
    const wasOpen = keyboardOpen
    keyboardOpen = small.matches && touchInput.matches && editing && gap > (keyboardOpen ? 80 : 120)
    if (keyboardOpen) {
      root.style.setProperty('--app-viewport-height', `${visual?.height || innerHeight}px`)
      root.style.setProperty('--app-viewport-top', `${visual?.offsetTop || 0}px`)
      root.dataset.keyboard = 'open'
    } else {
      // Native dvh owns the resting canvas. Never retain a sampled keyboard
      // height: iOS may dismiss the keyboard without blurring its input.
      clearGeometry()
      if (wasOpen && Math.abs(scale - 1) < .01 && (window.scrollY || window.scrollX)) window.scrollTo(0, 0)
    }
  }
  const schedule = () => { if (active && !frame) frame = requestAnimationFrame(measure) }
  const settle = () => {
    schedule()
    for (const timer of settling) window.clearTimeout(timer)
    settling.clear()
    for (const delay of [120, 350, 700]) {
      const timer = window.setTimeout(() => { settling.delete(timer); schedule() }, delay)
      settling.add(timer)
    }
  }
  const mediaChange = () => { restingHeight = Math.max(innerHeight, root.clientHeight); settle() }
  const preventGesture = (event: Event) => { if (event.cancelable) event.preventDefault() }
  const start = (event: TouchEvent) => { const touch = event.touches[0]; if (touch) { x = touch.clientX; y = touch.clientY } }
  const move = (event: TouchEvent) => {
    if (event.touches.length > 1) { if (touchInput.matches) preventGesture(event); return }
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
  window.addEventListener('resize', schedule); window.addEventListener('focusin', settle); window.addEventListener('focusout', settle); window.addEventListener('pageshow', settle); window.addEventListener('orientationchange', settle); small.addEventListener('change', mediaChange)
  const gesture = (event: Event) => { if (touchInput.matches) preventGesture(event) }
  document.addEventListener('gesturestart', gesture, { passive: false })
  document.addEventListener('gesturechange', gesture, { passive: false })
  document.addEventListener('touchstart', start, { passive: true, capture: true })
  document.addEventListener('touchmove', move, { passive: false, capture: true })


  return () => {
    active = false
    cancelAnimationFrame(frame)
    for (const timer of settling) window.clearTimeout(timer)
    settling.clear()
    clearGeometry()
    document.removeEventListener('gesturestart', gesture)
    document.removeEventListener('gesturechange', gesture)
    if (previousViewport !== null && previousViewport !== undefined) viewport?.setAttribute('content', previousViewport)
    visual?.removeEventListener('resize', schedule); visual?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule); window.removeEventListener('focusin', settle); window.removeEventListener('focusout', settle); window.removeEventListener('pageshow', settle); window.removeEventListener('orientationchange', settle); small.removeEventListener('change', mediaChange)
    document.removeEventListener('touchstart', start, true); document.removeEventListener('touchmove', move, true)
  }
}
