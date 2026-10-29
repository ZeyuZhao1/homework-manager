import { service } from './service'
import './systemPrint.css'

const PRINT_DOCUMENT_ID = 'system-print-document'
let preparing = false
let retainedDocument: { element: HTMLElement; release: () => void } | null = null

// Prepare only the selected file in the current document; no window or route is opened.
export async function printSystemFile(fileId: string): Promise<void> {
  if (preparing) throw new Error('正在准备其他打印请求，请稍候。')
  preparing = true
  retainedDocument?.release()
  const pages = document.createElement('div')
  pages.id = PRINT_DOCUMENT_ID
  pages.setAttribute('aria-hidden', 'true')
  document.body.append(pages)
  const objectUrls: string[] = []
  let dialogRequested = false
  let canceled = false
  const release = () => {
    pages.remove()
    if (!document.getElementById(PRINT_DOCUMENT_ID)) document.documentElement.classList.remove('printing-file')
    for (const url of objectUrls) URL.revokeObjectURL(url)
    window.removeEventListener('afterprint', release)
    if (retainedDocument?.element === pages) retainedDocument = null
  }
  try {
    const buffer = await service.readSystemPrintDocument(fileId)
    const bytes = new Uint8Array(buffer)
    const isPdf = new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')
    if (isPdf) {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href
      const assets = new URL('pdfjs/', document.baseURI).href
      const task = pdfjs.getDocument({ data: bytes, cMapUrl: `${assets}cmaps/`, cMapPacked: true, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/` })
      task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
        void requestPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD).then(password => {
          if (password === null) { canceled = true; void task.destroy() }
          else updatePassword(password)
        })
      }
      try {
        const pdf = await task.promise
        let totalPixels = 0
        for (let number = 1; number <= pdf.numPages; number++) {
          const page = await pdf.getPage(number)
          const viewport = page.getViewport({ scale: 150 / 72 })
          totalPixels += Math.ceil(viewport.width) * Math.ceil(viewport.height)
          if (totalPixels > 80_000_000 || viewport.width > 16000 || viewport.height > 16000) throw new Error('文档过大，请先将需要打印的页面另存为较小的 PDF。')
          const canvas = document.createElement('canvas')
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
          const context = canvas.getContext('2d')
          if (!context) throw new Error('无法创建打印画布')
          await page.render({ canvasContext: context, canvas, viewport, intent: 'print', background: 'white' }).promise
          const image = new Image()
          image.alt = `第 ${number} 页`
          image.src = canvas.toDataURL('image/png')
          await image.decode()
          appendPage(pages, image)
          canvas.width = 0; canvas.height = 0
          page.cleanup()
        }
      } finally { await task.destroy() }
    } else {
      const url = URL.createObjectURL(new Blob([buffer]))
      objectUrls.push(url)
      const image = new Image()
      image.alt = '待打印图片'; image.src = url
      try { await image.decode() }
      catch { throw new Error('无法读取图片，文件可能已损坏或格式不受支持。') }
      appendPage(pages, image)
    }
    await document.fonts.ready
    document.documentElement.classList.add('printing-file')
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    retainedDocument = { element: pages, release }
    window.addEventListener('afterprint', release, { once: true })
    await service.showSystemPrintDialog()
    dialogRequested = true
    // Some native WebViews acknowledge the dialog before it closes and do not emit
    // afterprint. Keep this bounded document until afterprint or the next explicit
    // print request, so asynchronous native printing never sees an empty document.
  } catch (error) {
    if (!canceled) throw error
  } finally {
    if (!dialogRequested) release()
    preparing = false
  }
}

function appendPage(container: HTMLElement, image: HTMLImageElement) {
  const page = document.createElement('section')
  page.className = 'system-print-page'
  page.append(image); container.append(page)
}

function requestPassword(incorrect: boolean): Promise<string | null> {
  return new Promise(resolve => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overlay = document.createElement('div')
    overlay.className = 'modal-backdrop'
    overlay.innerHTML = '<form class="modal" role="dialog" aria-modal="true" aria-label="解锁打印文件"><header class="modal-header"><h2>解锁打印文件</h2></header><div class="modal-body"><p class="modal-intro" role="status"></p><label class="form-field">PDF 密码<input type="password" autocomplete="off" required /></label></div><footer class="modal-footer"><button type="button" class="button button-quiet">取消</button><button type="submit" class="button button-primary">解锁并打印</button></footer></form>'
    const input = overlay.querySelector('input')!
    overlay.querySelector('p')!.textContent = incorrect ? '密码错误，请重新输入 PDF 密码。' : '此 PDF 已加密，请输入密码后打印。'
    const finish = (value: string | null) => {
      input.value = ''
      overlay.remove()
      if (previousFocus?.isConnected) previousFocus.focus()
      resolve(value)
    }
    overlay.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); finish(input.value) }, { once: true })
    overlay.querySelector('button[type="button"]')!.addEventListener('click', () => finish(null))
    overlay.addEventListener('mousedown', event => { if (event.target === overlay) finish(null) })
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null) }
      if (event.key === 'Tab') {
        const controls = [input, ...overlay.querySelectorAll('button')]
        const index = controls.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement)
        event.preventDefault()
        controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus()
      }
    })
    document.body.append(overlay)
    input.focus()
  })
}
