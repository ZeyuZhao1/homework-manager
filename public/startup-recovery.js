// The HTML shell remains usable even when the application module cannot start.
(() => {
  const shell = document.querySelector('[data-static-startup]')
  if (!shell) return
  const recovery = shell.querySelector('.startup-recovery')
  recovery.querySelector('button').addEventListener('click', () => location.reload())
  const show = (failed) => {
    if (!shell.isConnected) return
    recovery.hidden = false
    if (failed) {
      shell.querySelector('.startup-status').textContent = '暂时无法打开'
      recovery.querySelector('.startup-hint').textContent = '启动文件未能加载，请重新打开。'
      shell.querySelector('.startup-progress').hidden = true
    }
  }
  const timer = setTimeout(() => show(false), 10000)
  const onError = event => { if (event.target instanceof HTMLScriptElement && event.target.type === 'module') show(true) }
  window.addEventListener('error', onError, true)
  const observer = new MutationObserver(() => {
    if (!shell.isConnected) { clearTimeout(timer); window.removeEventListener('error', onError, true); observer.disconnect() }
  })
  observer.observe(shell.parentElement, { childList: true })
})()
