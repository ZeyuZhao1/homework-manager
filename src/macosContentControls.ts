import { service } from './service'
import type { MacosContentControl } from './service'

// A token belongs to an element instance, never to a particular assignment or position.
const tokens = new WeakMap<Element, string>()
let nextToken = 0
const selector = '[data-native-control]'
const contextOf = (element: HTMLElement) => element.closest<HTMLElement>('[data-native-context]')?.dataset.nativeContext
const blocking = '[aria-modal="true"]:not([hidden]), [role="menu"]:not([hidden]), .modal-backdrop, .drawer-scrim, .import-backdrop'

export function installMacosContentControls() {
  if (!service.isMacDesktop) return () => {}
  let disposed = false
  let scheduled = 0
  let sequence = 0
  let last = ''
  let active = new Map<string, HTMLElement>()
  let queue = Promise.resolve()
  const clearFallback = () => document.querySelectorAll('[data-native-installed]').forEach(el => el.removeAttribute('data-native-installed'))
  const schedule = () => {
    // A covered WKWebView may suspend animation frames across window
    // transitions. Keep geometry updates independent of WebKit painting.
    if (!scheduled) scheduled = window.setTimeout(update, 16)
  }
  const update = () => {
    scheduled = 0
    const blocked = !!document.querySelector(blocking)
    const entries = new Map<string, HTMLElement>()
    const controls: MacosContentControl[] = []
    if (!blocked) document.querySelectorAll<HTMLElement>(selector).forEach(element => {
      // Native views must never track content moving inside a WebKit scroller.
      if (!element.closest('[data-native-fixed]')) return
      const rect = element.getBoundingClientRect()
      if (!rect.width || !rect.height || rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return
      // Exclude partially scrolled and covered anchors instead of drawing over other content.
      let ancestor = element.parentElement
      while (ancestor) {
        const style = getComputedStyle(ancestor)
        if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) return
        if (/(hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
          const bounds = ancestor.getBoundingClientRect()
          if (rect.left < bounds.left || rect.right > bounds.right || rect.top < bounds.top || rect.bottom > bounds.bottom) return
        }
        ancestor = ancestor.parentElement
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      const overlap = element.closest('[data-native-overlap]')
      const scrollUnder = hit?.closest('[data-native-scroll-under]')
      const behindNative = element.hasAttribute('data-native-installed') && hit
        && (hit.contains(element) || (scrollUnder && overlap && scrollUnder.closest('[data-native-overlap]') === overlap))
      if (!hit || !(element === hit || element.contains(hit) || behindNative)) return
      let id = tokens.get(element)
      if (!id) { id = `content-${++nextToken}`; tokens.set(element, id) }
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('button'))
      const select = element instanceof HTMLSelectElement ? element : null
      const kind = select ? (element.hasAttribute('data-native-pull-down') ? 'menu' : 'select') : buttons.length ? 'segments' : 'button'
      const options = select ? Array.from(select.options, option => ({ id: option.value, name: option.text })) : buttons.map((button, index) => ({ id: String(index), name: button.textContent?.trim().replace(/\s+/g, ' ') || '' }))
      const selected = select?.value ?? (kind === 'button' ? element.getAttribute('aria-pressed') ?? '' : String(Math.max(0, buttons.findIndex(button => button.getAttribute('aria-pressed') === 'true'))))
      const tint = element.dataset.nativeTint
      const symbol = element.dataset.nativeSymbol
      controls.push({
        id, kind, x: rect.left, y: rect.top, width: rect.width, height: rect.height,
        label: element.getAttribute('aria-label') || element.textContent?.trim().replace(/\s+/g, ' ') || '',
        options, selected, context: contextOf(element),
        opaque: element.hasAttribute('data-native-opaque') || undefined,
        disabled: select?.disabled || (element instanceof HTMLButtonElement && element.disabled) || false,
        tint: tint === 'accent' || tint === 'destructive' ? tint : undefined,
        symbol: symbol === 'plus' || symbol === 'pencil' || symbol === 'trash' || symbol === 'chevron.right' ? symbol : undefined,
      })
      entries.set(id, element)
    })
    const payload = JSON.stringify(controls)
    if (payload === last) return
    last = payload
    const current = ++sequence
    // Immediately reject actions from an old page, even if AppKit is still catching up.
    active.forEach((element, id) => { if (!entries.has(id)) element.removeAttribute('data-native-installed') })
    active = entries
    queue = queue.then(async () => {
      if (disposed || current !== sequence) return
      try {
        const installed = await service.updateMacosContentControls(controls)
        if (disposed || current !== sequence) return
        if (installed) entries.forEach(element => element.setAttribute('data-native-installed', 'true'))
        else { last = ''; clearFallback() }
      } catch { if (current === sequence) { last = ''; clearFallback() } }
    })
  }
  const action = (event: Event) => {
    const detail = (event as CustomEvent<{ action?: string; value?: string; context?: string }>).detail
    if (detail?.action !== 'content' || typeof detail.value !== 'string' || document.querySelector(blocking)) return
    const [id, value] = detail.value.split(':')
    const element = active.get(id)
    if (!element?.isConnected || !element.hasAttribute('data-native-installed') || contextOf(element) !== detail.context) return
    if (element instanceof HTMLSelectElement) {
      if (!element.disabled && Array.from(element.options).some(option => option.value === value)) {
        element.value = value
        element.dispatchEvent(new Event('change', { bubbles: true }))
      }
    } else if (element instanceof HTMLButtonElement) element.click()
    else element.querySelectorAll<HTMLButtonElement>('button')[Number(value)]?.click()
  }
  window.addEventListener('homeworkbook:macos-chrome-action', action)
  window.addEventListener('resize', schedule)
  const mutations = new MutationObserver(schedule)
  mutations.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-modal', 'aria-pressed', 'disabled', 'value', 'data-native-tint', 'data-native-symbol', 'data-native-context'] })
  const resize = new ResizeObserver(schedule)
  resize.observe(document.body)
  schedule()
  return () => { disposed = true; sequence++; window.clearTimeout(scheduled); mutations.disconnect(); resize.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('homeworkbook:macos-chrome-action', action); clearFallback(); void service.updateMacosContentControls([]) }
}
