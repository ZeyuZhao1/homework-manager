import { useDialogFocus } from '../../../src/ui'
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { Check, ChevronDown, File, Settings2, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { service } from '../../../src/service'
import type { Course, ModuleDescriptor } from '../../../src/types'
import type { AiDraft, ProviderInput } from './types'
import { errorText, fileName, InlineError, Modal } from '../../../src/ui'
import { assignmentImportService } from './service'
import manifest from '../module.json'
import providerPresets from '../provider-presets.json'
import './importFlow.css'

export function AiDrawer({ courses, onClose, onSettings, onSaved }: { courses: Course[]; onClose: () => void; onSettings: () => void; onSaved: () => Promise<void> }) {
  const dialogRef = useRef<HTMLElement>(null)
  const [busy, setBusy] = useState(false)
  const analyzeController = useRef<AbortController | null>(null)
  const creating = useRef(false)
  const [text, setText] = useState('')
  const [paths, setPaths] = useState<string[]>([])
  const [pastedImages, setPastedImages] = useState<Record<string, string>>({})
  const [pasting, setPasting] = useState(0)
  const [drafts, setDrafts] = useState<AiDraft[]>([])
  const [step, setStep] = useState<'source' | 'review'>('source')
  const close = () => { if (busy && step === 'review') return; analyzeController.current?.abort(); onClose() }
  useDialogFocus(dialogRef, close)
  const [snapshot, setSnapshot] = useState<{ text: string; paths: string[]; sourceName: string; moduleId: string } | null>(null)
  const [error, setError] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [modules, setModules] = useState<ModuleDescriptor[]>([{ ...manifest, builtin: true, enabled: true }])
  const [moduleId, setModuleId] = useState(manifest.id)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; analyzeController.current?.abort() } }, [])
  useEffect(() => { void service.listModules().then(items => { const enabled = items.filter(module => module.enabled && module.capabilities.includes('assignment.extract')); if (enabled.length) { setModules(enabled); setModuleId(current => enabled.some(module => module.id === current) ? current : enabled[0].id) } }).catch(() => {}) }, [])
  const sourceMatches = snapshot !== null && snapshot.text === text && snapshot.sourceName === sourceName && snapshot.moduleId === moduleId && snapshot.paths.length === paths.length && snapshot.paths.every((path, index) => path === paths[index])
  const paste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is globalThis.File => !!file)
    if (!images.length) return
    event.preventDefault()
    if (busy) return
    const pastedText = event.clipboardData.getData('text/plain')
    if (pastedText) {
      const { selectionStart, selectionEnd } = event.currentTarget
      setText(current => current.slice(0, selectionStart) + pastedText + current.slice(selectionEnd))
    }
    setPasting(current => current + 1)
    setError('')
    try {
      for (const image of images) {
        const path = await assignmentImportService.savePastedImage(image)
        const preview = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error('读取图片预览失败'))
          reader.readAsDataURL(image)
        })
        if (!mounted.current) return
        setPaths(current => [...current, path])
        setPastedImages(current => ({ ...current, [path]: preview }))
      }
    } catch (reason) { if (mounted.current) setError(errorText(reason)) }
    finally { if (mounted.current) setPasting(current => current - 1) }
  }
  const pick = async () => { try { const files = await service.pickFiles(); if (mounted.current) setPaths(current => [...current, ...files]) } catch (e) { if (mounted.current) setError(errorText(e)) } }
  const analyze = async () => {
    if (analyzeController.current) return
    const controller = new AbortController()
    analyzeController.current = controller
    setBusy(true); setError('')
    try {
      const result = await assignmentImportService.analyze(text, paths, moduleId, controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      if (!Array.isArray(result.assignments)) throw new Error('识别模块返回格式无效')
      if (!result.assignments.length) throw new Error('没有识别到作业，请补充来源内容后重试。')
      setDrafts(result.assignments)
      setSnapshot({ text, paths: [...paths], sourceName, moduleId })
      setStep('review')
    } catch (e) { if (mounted.current && !controller.signal.aborted) setError(errorText(e)) } finally { if (analyzeController.current === controller) analyzeController.current = null; if (mounted.current) setBusy(false) }
  }
  const update = (index: number, patch: Partial<AiDraft>) => setDrafts(current => current.map((draft, i) => i === index ? { ...draft, ...patch } : draft))
  const create = async () => {
    if (creating.current || !drafts.length || !snapshot || !sourceMatches) return
    creating.current = true
    setBusy(true); setError('')
    try { await assignmentImportService.saveDrafts(drafts, snapshot.paths, snapshot.sourceName, snapshot.text); await onSaved() } catch (e) { if (mounted.current) setError(errorText(e)) } finally { creating.current = false; if (mounted.current) setBusy(false) }
  }
  const incomplete = drafts.some(draft => !draft.title.trim() || !courses.some(course => course.id === draft.course_id))
  return <><div className="drawer-scrim" onClick={close} /><aside ref={dialogRef} tabIndex={-1} className="ai-drawer import-flow" role="dialog" aria-modal="true" aria-label="导入作业">
    <header className="drawer-header"><h2><Sparkles size={20} />导入作业</h2><button className="icon-button glass-control" disabled={busy && step === 'review'} onClick={close} aria-label="关闭"><X size={19} /></button></header>
    <div className="import-progress" aria-label="导入步骤"><span className={step === 'source' ? 'current' : 'done'}>1 <b>添加来源</b></span><i /><span className={step === 'review' ? 'current' : ''}>2 <b>审核并创建</b></span></div>
    <div className="drawer-scroll import-scroll">
      {step === 'source' ? <section className="import-section">
        <h3>添加作业内容</h3><p className="import-intro">粘贴课程公告或截图，也可以选择题目文件。</p>
        <label className="form-field import-source-label">公告内容<textarea aria-label="作业来源文字或图片" onPaste={paste} disabled={busy} className="source-textarea" value={text} onChange={e => setText(e.target.value)} placeholder="粘贴作业公告文字或截图…" rows={7} /></label>
        <button className="upload-box" disabled={busy} onClick={() => void pick()}><Upload size={19} /><span>添加 PDF、图片或 DOCX 文件</span></button>
        {paths.length ? <div className="attached-list">{paths.map((path, i) => <div key={`${path}-${i}`}>{pastedImages[path] ? <img className="pasted-image-preview" src={pastedImages[path]} alt="粘贴的题目图片" /> : <File size={15} />}<span title={path}>{fileName(path)}</span><button disabled={busy} onClick={() => setPaths(current => current.filter((_, index) => index !== i))} aria-label={`移除附件 ${fileName(path)}`}><X size={14} /></button></div>)}</div> : null}
        <details className="import-options"><summary>来源与识别选项</summary><div><label className="form-field">来源平台 <small>可留空</small><input disabled={busy} value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="例如 Moodle、课程群、邮件" /></label>{modules.length > 1 ? <label className="form-field">识别模块<select disabled={busy} value={moduleId} onChange={e => setModuleId(e.target.value)}>{modules.map(module => <option key={module.id} value={module.id}>{module.name}{module.builtin ? ' · 内置' : ' · 外部'}</option>)}</select></label> : null}<button className="button button-quiet" disabled={busy} onClick={onSettings}><Settings2 size={16} />模型设置</button></div></details>
        <p className="helper-text import-privacy">{assignmentImportService.isCloud ? '点击开始识别后，将为尚未上传的附件逐个请求上传确认；只有已确认上传的附件会发送给服务商。每次最多 4 个附件，合计最多 20 MB。粘贴图片暂存于当前页面，创建后关联为题目材料。' : '点击开始识别后，本次内容才会发送给所选服务商。支持粘贴 PNG、JPEG、WebP 图片（每张最多 20 MB）。桌面粘贴图片保存在应用本地，创建后关联为题目材料；移除或取消不会删除已保存的图片。'}</p>
        {snapshot && drafts.length ? <div className="import-return">{sourceMatches ? <><span>上次审核的修改仍保留。</span><button className="button button-quiet" disabled={busy || pasting > 0} onClick={() => { setError(''); setStep('review') }}>返回审核</button></> : <span>来源已更改，原审核结果暂不可创建。恢复原来源可继续审核，或重新识别生成新结果。</span>}</div> : null}
      </section> : <section className="import-section">
        <h3>审核识别结果</h3><p className="import-intro">共识别 {drafts.length} 项。检查课程与截止时间，展开可编辑完整内容。</p>
        {drafts.map((draft, index) => {
          const course = courses.find(item => item.id === draft.course_id)
          const missing = [!draft.title.trim() ? '缺少标题' : '', !course ? '请选择课程' : '', !draft.due_at ? '未识别截止时间' : ''].filter(Boolean)
          return <details className="import-draft" key={index}>
            <summary><span className="import-draft-title">{draft.title || '未填写标题'}</span><span className="import-draft-meta">{course?.name || draft.course_name || '未匹配课程'} · {draft.due_at ? draft.due_at.slice(0, 16).replace('T', ' ') : '无截止时间'}</span>{missing.length ? <span className="import-missing">{missing.join(' · ')}</span> : null}<ChevronDown className="import-draft-chevron" size={16} aria-hidden="true" /></summary>
            <div className="import-draft-fields"><div className="import-draft-actions"><strong>作业 {index + 1}</strong><button className="button button-quiet danger-hover" disabled={busy} onClick={() => setDrafts(current => current.filter((_, i) => i !== index))}><Trash2 size={16} />移除</button></div>
              <label className="form-field">课程<select disabled={busy} value={draft.course_id} onChange={e => update(index, { course_id: e.target.value })}><option value="">请选择课程</option>{courses.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
              <label className="form-field">作业标题<input disabled={busy} value={draft.title} onChange={e => update(index, { title: e.target.value })} /></label>
              <label className="form-field">截止时间 <small>可留空</small><input disabled={busy} type="datetime-local" value={draft.due_at?.slice(0, 16) || ''} onChange={e => update(index, { due_at: e.target.value ? `${e.target.value}:00` : null })} /></label>
              <label className="form-field">提交位置<input disabled={busy} value={draft.submission_label} onChange={e => update(index, { submission_label: e.target.value })} /></label>
              <label className="form-field">提交链接<input disabled={busy} value={draft.submission_url} onChange={e => update(index, { submission_url: e.target.value })} /></label>
              <label className="form-field">提交备注<textarea disabled={busy} rows={2} value={draft.submission_notes} onChange={e => update(index, { submission_notes: e.target.value })} /></label>
              <label className="form-field">说明<textarea disabled={busy} rows={2} value={draft.description} onChange={e => update(index, { description: e.target.value })} /></label>
              {draft.evidence ? <div className="evidence"><span>原文依据</span>{draft.evidence}</div> : null}
            </div>
          </details>
        })}
        {!drafts.length ? <p className="helper-text">已移除全部结果，返回来源可重新识别。</p> : incomplete ? <p className="import-required">请展开标记的作业，填写标题并选择课程后创建。</p> : null}
      </section>}
      {error ? <InlineError>{error}</InlineError> : null}
    </div>
    <footer className="drawer-footer import-footer">{busy ? <span className="import-busy" role="status">{step === 'source' ? '正在处理识别请求。关闭后已发送的请求可能仍在服务端处理。' : '正在创建作业，请等待完成。'}</span> : null}{step === 'source' ? <><button className="button button-quiet" onClick={close}>取消</button><button className="button button-primary" onClick={() => void analyze()} disabled={busy || pasting > 0 || (!text.trim() && !paths.length)}><Sparkles size={16} />{busy ? '识别中…' : pasting ? '正在保存图片…' : '开始识别'}</button></> : <><button className="button button-quiet" disabled={busy} onClick={() => { setError(''); setStep('source') }}>返回来源</button><button className="button button-primary" onClick={() => void create()} disabled={busy || !drafts.length || incomplete || !sourceMatches}><Check size={17} />{busy ? '创建中…' : `确认创建（${drafts.length}）`}</button></>}</footer>
  </aside></>
}

export function ProviderEditor({ initial, error, onClose, onSave }: { initial: ProviderInput; error: string; onClose: () => void; onSave: (value: ProviderInput) => Promise<void> }) {
  const [item,setItem] = useState(initial)
  const cloudId = useRef(initial.id || crypto.randomUUID())
  const [saving,setSaving] = useState(false)
  const save = async () => { if(saving)return;setSaving(true);try { await onSave({ ...item, id: assignmentImportService.isCloud ? cloudId.current : item.id }) } finally { setSaving(false) } }
  const chooseKind = (kind: ProviderInput['kind']) => setItem(current => ({ ...current, kind, base_url: kind === 'custom' ? current.base_url : providerPresets[kind].base_url, model: kind === 'custom' ? current.model : providerPresets[kind].model }))
  return <Modal title={item.id ? '编辑 AI 服务商' : '添加 AI 服务商'} onClose={onClose} closeDisabled={saving} wide footer={<>{error ? <div className="provider-save-error" role="alert">{error}</div> : null}<button className="button button-quiet" disabled={saving} onClick={onClose}>取消</button><button className="button button-primary" disabled={saving || !item.name.trim() || !item.model.trim() || !item.base_url.trim()} onClick={() => void save()}>{saving ? '保存中…' : '保存服务商'}</button></>}><div className="form-grid"><label className="form-field">名称<input value={item.name} onChange={e => setItem({ ...item,name:e.target.value })} placeholder="例如 百炼-作业识别" /></label><label className="form-field">类型<select value={item.kind} onChange={e => chooseKind(e.target.value as ProviderInput['kind'])}><option value="bailian">阿里云百炼</option><option value="deepseek">DeepSeek</option><option value="gemini">Google Gemini</option><option value="custom">自定义兼容接口</option></select></label><label className="form-field span-2">API Base URL<input value={item.base_url} onChange={e => setItem({ ...item,base_url:e.target.value })} placeholder="https://…/v1" /></label><label className="form-field">模型名称<input value={item.model} onChange={e => setItem({ ...item,model:e.target.value })} placeholder="例如 qwen3.8-max" /></label>{assignmentImportService.isDesktop || assignmentImportService.isCloud ? <label className="form-field">API Key <small>{item.has_key ? '已配置，留空保留原密钥' : '可在这里填写'}</small><input type="password" value={item.api_key} onChange={e => setItem({ ...item,api_key:e.target.value })} autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder={assignmentImportService.isDesktop ? '仅保存到系统安全凭据存储' : '加密保存到个人云端，不会回显'} /></label> : <p className="helper-text">浏览器演示只保存服务商资料，不接收 API Key。</p>}</div><div className="provider-info"><ShieldCheck size={18} /><span>百炼 PDF 需要支持 PDF 理解的模型；DOCX 需要 qwen-long 或 qwen-doc-turbo。DeepSeek 支持文字和视觉模型的图片输入，不支持原始 PDF 或 DOCX。Gemini 使用原生 API，支持文字、图片和 PDF；当前模块不传入 DOCX。自定义接口仅支持文字输入。</span></div></Modal>
}
