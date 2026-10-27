import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, LoaderCircle, Printer } from 'lucide-react'
import { service } from './service'
import type { FileAsset, ModuleDescriptor } from './types'
import { errorText, fileName, Modal } from './ui'

interface PrintConfig {
  printer: string
  copies: number
  pages: string
  duplex: 'simplex' | 'long-edge' | 'short-edge'
  color: 'monochrome' | 'color'
  paper: 'A4' | 'A3' | 'Letter'
  orientation: 'portrait' | 'landscape'
  renderer_path: string
}
interface PrintConfiguration {
  config: PrintConfig
  printers: { name: string; is_default: boolean }[]
  school_client?: { detected: boolean; path: string }
  supported_formats?: string[]
  warning?: string | null
}
interface PrintResult {
  queued: number
  files?: { path: string; queued: boolean; error?: string | null }[]
  warning?: string | null
}

// Keep a pending submission guarded even if its file row is unmounted and reopened.
const pendingFiles = new Set<string>()

export function PrintSettingsDialog({ module, onClose }: { module: ModuleDescriptor; onClose: () => void }) {
  const [response, setResponse] = useState<PrintConfiguration | null>(null)
  const [config, setConfig] = useState<PrintConfig | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const working = useRef(false)
  const available = module.enabled && service.isDesktop && module.capabilities.includes('file.print.configure')
  useEffect(() => {
    if (!available) return
    let alive = true
    void service.invokeModule<PrintConfiguration>(module.id, 'file.print.configure', { operation: 'get' }).then(result => {
      if (alive) { setResponse(result); setConfig(result.config) }
    }).catch(reason => { if (alive) setError(`读取打印设置失败：${errorText(reason)}`) }).finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
  }, [module.id, available])
  const update = (patch: Partial<PrintConfig>) => { setConfig(current => current ? { ...current, ...patch } : current); setMessage('') }
  const save = async () => {
    if (!available || !config || busy || working.current) return
    if (!Number.isInteger(config.copies) || config.copies < 1 || config.copies > 99) { setError('份数必须是 1 到 99 之间的整数。'); return }
    working.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result = await service.invokeModule<PrintConfiguration>(module.id, 'file.print.configure', { operation: 'save', config })
      setResponse(result); setConfig(result.config); setMessage('默认打印设置已保存。')
    } catch (reason) { setError(`保存打印设置失败：${errorText(reason)}`) }
    finally { working.current = false; setBusy(false) }
  }
  const authenticate = async () => {
    if (!available || busy || working.current || !module.capabilities.includes('file.print.authenticate')) return
    working.current = true; setBusy(true); setError(''); setMessage('')
    try {
      const result = await service.invokeModule<{ warning?: string | null }>(module.id, 'file.print.authenticate', {})
      setMessage(result.warning || '已连接学校打印客户端。')
    } catch (reason) { setError(`连接学校打印客户端失败：${errorText(reason)}`) }
    finally { working.current = false; setBusy(false) }
  }
  return <Modal title={`${module.name} · 打印设置`} onClose={onClose} footer={<><button className="button button-quiet" onClick={onClose}>关闭</button><button className="button button-primary" disabled={!available || busy || !config || !config.printer} onClick={() => { void save() }}>保存默认设置</button></>}>
    <p className="modal-intro">一键打印使用此模块保存的默认设置，只提交当前点击的文件。提交到打印流程后，仍需在打印机或学校终端确认实际结果。</p>
    {!service.isDesktop ? <p className="inline-error" role="alert">浏览器预览无法读取本机打印机或执行打印，请使用桌面应用。</p> : !module.enabled ? <p className="inline-error" role="alert">模块已关闭，请先启用模块。</p> : null}
    {available && busy && !config ? <p role="status">正在读取打印机和配置…</p> : null}
    {config && available ? <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="form-grid">
      <label className="form-field span-2">打印机<select value={config.printer} onChange={event => update({ printer: event.target.value })}><option value="">请选择打印机</option>{config.printer && !response?.printers.some(printer => printer.name === config.printer) ? <option value={config.printer}>{config.printer}（未检测到）</option> : null}{response?.printers.map(printer => <option key={printer.name} value={printer.name}>{printer.name}{printer.is_default ? '（系统默认）' : ''}</option>)}</select></label>
      <label className="form-field">份数<input type="number" min={1} max={99} step={1} value={config.copies || ''} onChange={event => update({ copies: Number(event.target.value) })} /></label>
      <label className="form-field">页码<input value={config.pages} placeholder="全部，或 1-3,5" onChange={event => update({ pages: event.target.value })} /></label>
      <label className="form-field">单双面<select value={config.duplex} onChange={event => update({ duplex: event.target.value as PrintConfig['duplex'] })}><option value="simplex">单面</option><option value="long-edge">双面 · 长边翻转</option><option value="short-edge">双面 · 短边翻转</option></select></label>
      <label className="form-field">颜色<select value={config.color} onChange={event => update({ color: event.target.value as PrintConfig['color'] })}><option value="monochrome">黑白</option><option value="color">彩色</option></select></label>
      <label className="form-field">纸张<select value={config.paper} onChange={event => update({ paper: event.target.value as PrintConfig['paper'] })}><option>A4</option><option>A3</option><option>Letter</option></select></label>
      <label className="form-field">方向<select value={config.orientation} onChange={event => update({ orientation: event.target.value as PrintConfig['orientation'] })}><option value="portrait">纵向</option><option value="landscape">横向</option></select></label>
      <label className="form-field span-2">文档打印程序路径<input value={config.renderer_path} onChange={event => update({ renderer_path: event.target.value })} placeholder="由模块自动检测，或填写绝对路径" /><small>具体支持的程序由模块决定。</small></label>
    </div><p className="helper-text">页码指文件的实际页码，从 1 开始；留空打印全部页。不会自动使用关联信息中的教材页码。打印机需支持所选参数。</p>
    {response?.supported_formats?.length ? <p className="helper-text">模块支持的文件格式：{response.supported_formats.join('、')}</p> : null}
    {!response?.printers.length ? <p className="helper-text">未检测到打印机。请先在 Windows 中安装打印机，再重新打开此设置。</p> : null}
    {response?.school_client ? <p className="helper-text">学校打印客户端：{response.school_client.detected ? '已检测到' : '未检测到'}</p> : null}
    {module.capabilities.includes('file.print.authenticate') ? <><p className="helper-text">学校登录由本机客户端处理。首次登录、验证码或校园网络连接可能需要你在客户端中完成。</p><button className="button button-quiet" onClick={() => { void authenticate() }}>连接学校打印客户端</button></> : null}
    </fieldset> : null}
    {response?.warning ? <p className="helper-text">{response.warning}</p> : null}
    {message ? <p className="helper-text" role="status">{message}</p> : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </Modal>
}

export function PrintFileActions({ file, modules, renderActions }: { file?: FileAsset; modules: ModuleDescriptor[]; renderActions?: (actions: ReactNode) => ReactNode }) {
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [settingsModule, setSettingsModule] = useState<ModuleDescriptor | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const module = modules.find(item => item.id === selectedId) || modules[0]
  if (!module) return renderActions ? renderActions(null) : null
  const print = async () => {
    if (!file || file.missing || busy || !module.enabled) return
    if (!service.isDesktop) { setResult('浏览器预览无法执行打印，请使用桌面应用。'); return }
    if (pendingFiles.has(file.path)) { setResult('此文件正在提交打印，请等待结果并检查打印队列。'); return }
    pendingFiles.add(file.path); setBusy(true)
    try {
      const response = await service.invokeModule<PrintResult>(module.id, 'file.print', { paths: [file.path] })
      if (!Number.isInteger(response.queued) || response.queued < 0 || response.queued > 1) throw new Error('模块返回了无效的打印结果。')
      const failures = response.files?.filter(item => !item.queued).map(item => `${fileName(item.path)}：${item.error || '未成功提交'}`) || []
      setResult([`“${module.name}”：已提交 ${response.queued} 个文件。`, ...failures, response.warning, '提交不代表物理打印完成。若提交状态不明，请先检查 Windows 和学校打印队列，再决定是否重试。'].filter(Boolean).join('\n'))
    } catch (reason) { setResult(`打印请求未正常完成：${errorText(reason)}\n提交状态可能不明，请检查打印队列后再决定是否重试。`) }
    finally { pendingFiles.delete(file.path); setBusy(false) }
  }
  const actions = <>
    <button className={renderActions ? undefined : "icon-button tiny"} role={renderActions ? "menuitem" : undefined} title={service.isDesktop ? `打印当前文件 · ${module.name}` : '打印仅在桌面应用中可用'} aria-label={`打印当前文件 · ${module.name}`} disabled={!file || file.missing || busy || !service.isDesktop} onClick={() => { void print() }}>{busy ? <LoaderCircle size={15} /> : <Printer size={15} />}{renderActions ? (busy ? "正在提交打印…" : "打印") : null}</button>
    <button className={renderActions ? undefined : "icon-button tiny"} role={renderActions ? "menuitem" : undefined} title="打印选项与配置" aria-label="打印选项与配置" disabled={busy} onClick={() => setOptionsOpen(true)}><ChevronDown size={13} />{renderActions ? "打印选项与配置" : null}</button>
  </>
  return <>
    {renderActions ? renderActions(actions) : actions}
    {optionsOpen ? <Modal title="打印选项" onClose={() => setOptionsOpen(false)}><p className="modal-intro">选择负责打印的模块。选择右键菜单中的“打印”，将使用该模块保存的设置。</p>{modules.map(item => <div className="module-row" key={item.id}><label className="checkbox-label"><input type="radio" name="print-module" checked={module.id === item.id} onChange={() => setSelectedId(item.id)} />{item.name}</label>{item.capabilities.includes('file.print.configure') ? <button className="button button-quiet" onClick={() => { setOptionsOpen(false); setSettingsModule(item) }}>打印配置</button> : null}</div>)}</Modal> : null}
    {settingsModule ? <PrintSettingsDialog module={settingsModule} onClose={() => setSettingsModule(null)} /> : null}
    {result ? <Modal title="打印结果" onClose={() => setResult(null)} footer={<button className="button button-primary" onClick={() => setResult(null)}>知道了</button>}><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} role="status">{result}</p></Modal> : null}
  </>
}
