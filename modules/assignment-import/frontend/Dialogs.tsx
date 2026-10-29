import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, File, Settings2, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { service } from '../../../src/service'
import type { Course, ModuleDescriptor } from '../../../src/types'
import type { AiDraft, ProviderInput } from './types'
import { errorText, fileName, InlineError, Modal, useDialogFocus } from '../../../src/ui'
import { assignmentImportService } from './service'
import manifest from '../module.json'
import providerPresets from '../provider-presets.json'

export function AiDrawer({ courses, onClose, onSettings, onSaved }: { courses: Course[]; onClose: () => void; onSettings: () => void; onSaved: () => Promise<void> }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [text, setText] = useState('')
  const [paths, setPaths] = useState<string[]>([])
  const [pastedImages, setPastedImages] = useState<Record<string, string>>({})
  const [pasting, setPasting] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
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
  const [drafts, setDrafts] = useState<AiDraft[]>([])
  const [operation, setOperation] = useState<'analyze' | 'save' | ''>('')
  const busy = !!operation
  const [error, setError] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [modules, setModules] = useState<ModuleDescriptor[]>([{ ...manifest, builtin: true, enabled: true }])
  const [moduleId, setModuleId] = useState(manifest.id)
  useEffect(() => { void service.listModules().then(items => { const enabled = items.filter(module => module.enabled && module.capabilities.includes('assignment.extract')); if (enabled.length) { setModules(enabled); setModuleId(current => enabled.some(module => module.id === current) ? current : enabled[0].id) } }).catch(() => {}) }, [])
  const pick = async () => { try { const files = await service.pickFiles(); if (mounted.current) setPaths(current => [...new Set([...current, ...files])]) } catch (reason) { if (mounted.current) setError(errorText(reason)) } }
  const analyze = async () => { if (busy) return; setOperation('analyze'); setError(''); setDrafts([]); try { const result = await assignmentImportService.analyze(text,paths,moduleId); if (!Array.isArray(result.assignments) || !result.assignments.length) throw new Error('未识别到作业，请补充来源内容后重试'); if (mounted.current) setDrafts(result.assignments) } catch (e) { if (mounted.current) setError(errorText(e)) } finally { if (mounted.current) setOperation('') } }
  const update = (index: number, patch: Partial<AiDraft>) => setDrafts(current => current.map((draft,i) => i === index ? { ...draft, ...patch } : draft))
  const create = async () => { if (busy || !drafts.length) return; setOperation('save'); setError(''); try { await assignmentImportService.saveDrafts(drafts,paths,sourceName,text); await onSaved() } catch (e) { if (mounted.current) setError(errorText(e)) } finally { if (mounted.current) setOperation('') } }
  return createPortal(<><div className="drawer-scrim" onClick={onClose} /><aside ref={dialogRef} tabIndex={-1} className="ai-drawer" role="dialog" aria-modal="true" aria-label="导入作业"><header className="drawer-header"><h2><Sparkles size={20} />导入作业</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></header><div className="drawer-scroll"><section className="drawer-section"><div className="step-heading"><b>1</b><div><h3>来源内容</h3><p>粘贴公告文字，或添加题目文件交给已配置的云端模型识别。</p></div></div><label className="form-field">来源平台 <small>可留空</small><input disabled={busy} value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="例如 Moodle、课程群、邮件" /></label><label className="form-field">识别模块<select disabled={busy} value={moduleId} onChange={e => setModuleId(e.target.value)}>{modules.filter(module => module.enabled && module.capabilities.includes("assignment.extract")).map(module => <option key={module.id} value={module.id}>{module.name}{module.builtin ? " · 内置" : " · 外部"}</option>)}</select></label><textarea aria-label="作业来源文字或图片" onPaste={paste} disabled={busy} className="source-textarea" value={text} onChange={e => setText(e.target.value)} placeholder="粘贴作业公告文字或截图（Ctrl+V）…" rows={7} /><button className="upload-box" disabled={busy || pasting > 0} onClick={pick}><Upload size={19} /><span>选择 PDF、图片或 DOCX 文件</span></button>{paths.length ? <div className="attached-list">{paths.map((path,i) => <div key={`${path}-${i}`}>{pastedImages[path] ? <img className="pasted-image-preview" src={pastedImages[path]} alt="粘贴的题目图片" /> : <File size={15} />}<span title={path}>{fileName(path)}</span><button disabled={busy} onClick={() => setPaths(current => current.filter((_,index) => index !== i))} aria-label="移除附件"><X size={14} /></button></div>)}</div> : null}<p className="helper-text">点击“开始识别”才会向所选服务商发送内容。支持粘贴 PNG、JPEG、WebP 图片，每张最多 20 MB。</p><details className="attachment-storage-note"><summary>附件如何保存</summary><p className="helper-text">粘贴图片保存在应用本地目录，创建后关联为题目材料。移除附件或取消导入不会删除本地图片。</p></details><div className="drawer-controls"><button className="button button-quiet" disabled={busy} onClick={onSettings}><Settings2 size={16} />模型设置</button><button className="button button-primary" onClick={analyze} disabled={busy || pasting > 0 || (!text.trim() && !paths.length)}><Sparkles size={16} />{operation === 'analyze' ? '识别中…' : pasting ? '正在保存图片…' : '开始识别'}</button></div></section>{drafts.length ? <section className="drawer-section"><div className="step-heading"><b>2</b><div><h3>逐条审核</h3><p>共识别 {drafts.length} 项。请检查课程和截止时间后再创建。</p></div></div>{drafts.map((draft,index) => <fieldset disabled={busy} className="draft-card" key={index}><div className="draft-top"><strong>作业 {index + 1}</strong><button className="icon-button tiny danger-hover" onClick={() => setDrafts(current => current.filter((_,i) => i !== index))} title="移除这一项"><Trash2 size={16} /></button></div><label className="form-field">课程<select value={draft.course_id} onChange={e => update(index,{ course_id:e.target.value })}><option value="">请选择课程</option>{courses.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label className="form-field">作业标题<input value={draft.title} onChange={e => update(index,{ title:e.target.value })} /></label><label className="form-field">截止时间 <small>可留空</small><input type="datetime-local" value={draft.due_at?.slice(0,16) || ''} onChange={e => update(index,{ due_at:e.target.value ? `${e.target.value}:00` : null })} /></label><label className="form-field">提交位置<input value={draft.submission_label} onChange={e => update(index,{ submission_label:e.target.value })} /></label><label className="form-field">提交链接<input value={draft.submission_url} onChange={e => update(index,{ submission_url:e.target.value })} /></label><label className="form-field">说明<textarea rows={2} value={draft.description} onChange={e => update(index,{ description:e.target.value })} /></label>{draft.evidence ? <div className="evidence"><span>原文依据</span>{draft.evidence}</div> : null}</fieldset>)}</section> : null}</div>{error ? <InlineError>{error}</InlineError> : null}<footer className="drawer-footer"><button className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" onClick={create} disabled={busy || pasting > 0 || !drafts.length || drafts.some(draft => !courses.some(course => course.id === draft.course_id) || !draft.title.trim())}><Check size={17} />{operation === 'save' ? '创建中…' : `确认创建${drafts.length ? `（${drafts.length}）` : ''}`}</button></footer></aside></>, document.body)
}

export function ProviderEditor({ initial, onClose, onSave }: { initial: ProviderInput; onClose: () => void; onSave: (value: ProviderInput) => Promise<void> }) {
  const [item,setItem] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => { if (saving) return; setSaving(true); setError(''); try { await onSave(item) } catch (reason) { setError(errorText(reason)) } finally { setSaving(false) } }
  const chooseKind = (kind: ProviderInput['kind']) => setItem(current => ({ ...current, kind, base_url: kind === 'custom' ? current.base_url : providerPresets[kind].base_url, model: kind === 'custom' ? current.model : providerPresets[kind].model }))
  return <Modal title={item.id ? '编辑 AI 服务商' : '添加 AI 服务商'} onClose={onClose} wide footer={<><button className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" disabled={saving || !item.name.trim() || !item.model.trim() || !item.base_url.trim() || (!item.has_key && !item.api_key.trim())} onClick={() => void save()}>{saving ? '保存中…' : '保存服务商'}</button></>}><fieldset className="form-grid provider-fields" disabled={saving}><label className="form-field">名称<input value={item.name} onChange={e => setItem({ ...item,name:e.target.value })} placeholder="例如 百炼-作业识别" /></label><label className="form-field">类型<select value={item.kind} onChange={e => chooseKind(e.target.value as ProviderInput['kind'])}><option value="bailian">阿里云百炼</option><option value="deepseek">DeepSeek</option><option value="gemini">Google Gemini</option><option value="custom">自定义兼容接口</option></select></label><label className="form-field span-2">API Base URL<input value={item.base_url} onChange={e => setItem({ ...item,base_url:e.target.value })} placeholder="https://…/v1" /></label><label className="form-field">模型名称<input value={item.model} onChange={e => setItem({ ...item,model:e.target.value })} placeholder="例如 qwen3.8-max" /></label><label className="form-field">API Key <small>{item.has_key ? '留空表示保持原密钥' : '必填'}</small><input type="password" value={item.api_key} onChange={e => setItem({ ...item,api_key:e.target.value })} placeholder="仅保存到系统安全凭据存储" /></label></fieldset>{error ? <InlineError>{error}</InlineError> : null}<div className="provider-info"><ShieldCheck size={18} /><span>百炼：PDF 需兼容模型，DOCX 需 qwen-long 或 qwen-doc-turbo。DeepSeek：文字与兼容模型的图片。Gemini：文字、图片与 PDF。自定义接口：仅文字。</span></div></Modal>
}
