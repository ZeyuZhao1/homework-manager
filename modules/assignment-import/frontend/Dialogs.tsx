import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent } from 'react'
import { Check, File, Settings2, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import { service } from '../../../src/service'
import type { Course, ModuleDescriptor } from '../../../src/types'
import type { AiDraft, ProviderInput } from './types'
import { errorText, fileName, InlineError, Modal } from '../../../src/ui'
import { assignmentImportService } from './service'
import manifest from '../module.json'
import providerPresets from '../provider-presets.json'

export function AiDrawer({ courses, onClose, onSettings, onSaved }: { courses: Course[]; onClose: () => void; onSettings: () => void; onSaved: () => Promise<void> }) {
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [modules, setModules] = useState<ModuleDescriptor[]>([{ ...manifest, builtin: true, enabled: true }])
  const [moduleId, setModuleId] = useState(manifest.id)
  useEffect(() => { void service.listModules().then(items => { const enabled = items.filter(module => module.enabled && module.capabilities.includes('assignment.extract')); if (enabled.length) { setModules(enabled); setModuleId(current => enabled.some(module => module.id === current) ? current : enabled[0].id) } }).catch(() => {}) }, [])
  const pick = async () => { const files = await service.pickFiles(); setPaths(current => [...current, ...files]) }
  const analyze = async () => { setBusy(true); setError(''); try { const result = await assignmentImportService.analyze(text,paths,moduleId); if (!Array.isArray(result.assignments)) throw new Error('识别模块返回格式无效'); setDrafts(result.assignments) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  const update = (index: number, patch: Partial<AiDraft>) => setDrafts(current => current.map((draft,i) => i === index ? { ...draft, ...patch } : draft))
  const create = async () => { if (!drafts.length) return; setBusy(true); setError(''); try { await assignmentImportService.saveDrafts(drafts,paths,sourceName,text); await onSaved() } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  return <><div className="drawer-scrim" onClick={onClose} /><aside className="ai-drawer" role="dialog" aria-modal="true" aria-label="导入作业"><header className="drawer-header"><h2><Sparkles size={20} />导入作业</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></header><div className="drawer-scroll"><section className="drawer-section"><div className="step-heading"><b>1</b><div><h3>来源内容</h3><p>粘贴公告文字，或添加题目文件交给已配置的云端模型识别。</p></div></div><label className="form-field">来源平台 <small>可留空</small><input value={sourceName} onChange={e => setSourceName(e.target.value)} placeholder="例如 Moodle、课程群、邮件" /></label><label className="form-field">识别模块<select value={moduleId} onChange={e => setModuleId(e.target.value)}>{modules.filter(module => module.enabled && module.capabilities.includes("assignment.extract")).map(module => <option key={module.id} value={module.id}>{module.name}{module.builtin ? " · 内置" : " · 外部"}</option>)}</select></label><textarea aria-label="作业来源文字或图片" onPaste={paste} disabled={busy} className="source-textarea" value={text} onChange={e => setText(e.target.value)} placeholder="粘贴作业公告文字或截图（Ctrl+V）…" rows={7} /><button className="upload-box" onClick={pick}><Upload size={19} /><span>选择 PDF、图片或 DOCX 文件</span></button>{paths.length ? <div className="attached-list">{paths.map((path,i) => <div key={`${path}-${i}`}>{pastedImages[path] ? <img className="pasted-image-preview" src={pastedImages[path]} alt="粘贴的题目图片" /> : <File size={15} />}<span title={path}>{fileName(path)}</span><button onClick={() => setPaths(current => current.filter((_,index) => index !== i))} aria-label="移除附件"><X size={14} /></button></div>)}</div> : null}<p className="helper-text">{assignmentImportService.isCloud ? '点击开始识别后，将为尚未上传的附件逐个请求上传确认；只有已确认上传的附件会发送给服务商。每次最多 4 个附件，合计最多 20 MB。粘贴图片暂存于当前页面，创建后关联为题目材料。' : '只有点击开始识别后，本次内容才会发送给所选服务商。支持直接粘贴文字或 PNG、JPEG、WebP 截图（每张最多 20 MB）。桌面粘贴图片保存在应用本地目录；创建作业后关联为题目材料。移除附件或取消导入不会删除已保存图片。'}</p><div className="drawer-controls"><button className="button button-quiet" onClick={onSettings}><Settings2 size={16} />模型设置</button><button className="button button-primary" onClick={analyze} disabled={busy || pasting > 0 || (!text.trim() && !paths.length)}><Sparkles size={16} />{busy ? '识别中…' : pasting ? '正在保存图片…' : '开始识别'}</button></div></section>{drafts.length ? <section className="drawer-section"><div className="step-heading"><b>2</b><div><h3>逐条审核</h3><p>共识别 {drafts.length} 项。请检查课程和截止时间后再创建。</p></div></div>{drafts.map((draft,index) => <div className="draft-card" key={index}><div className="draft-top"><strong>作业 {index + 1}</strong><button className="icon-button tiny danger-hover" onClick={() => setDrafts(current => current.filter((_,i) => i !== index))} title="移除这一项"><Trash2 size={16} /></button></div><label className="form-field">课程<select value={draft.course_id} onChange={e => update(index,{ course_id:e.target.value })}><option value="">请选择课程</option>{courses.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label><label className="form-field">作业标题<input value={draft.title} onChange={e => update(index,{ title:e.target.value })} /></label><label className="form-field">截止时间 <small>可留空</small><input type="datetime-local" value={draft.due_at?.slice(0,16) || ''} onChange={e => update(index,{ due_at:e.target.value ? `${e.target.value}:00` : null })} /></label><label className="form-field">提交位置<input value={draft.submission_label} onChange={e => update(index,{ submission_label:e.target.value })} /></label><label className="form-field">提交链接<input value={draft.submission_url} onChange={e => update(index,{ submission_url:e.target.value })} /></label><label className="form-field">说明<textarea rows={2} value={draft.description} onChange={e => update(index,{ description:e.target.value })} /></label>{draft.evidence ? <div className="evidence"><span>原文依据</span>{draft.evidence}</div> : null}</div>)}</section> : null}{error ? <InlineError>{error}</InlineError> : null}</div><footer className="drawer-footer"><button className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" onClick={create} disabled={busy || pasting > 0 || !drafts.length}><Check size={17} />确认创建 {drafts.length ? `(${drafts.length})` : ''}</button></footer></aside></>
}

export function ProviderEditor({ initial, onClose, onSave }: { initial: ProviderInput; onClose: () => void; onSave: (value: ProviderInput) => Promise<void> }) {
  const [item,setItem] = useState(initial)
  const cloudId = useRef(initial.id || crypto.randomUUID())
  const [saving,setSaving] = useState(false)
  const save = async () => { if(saving)return;setSaving(true);try { await onSave({ ...item, id: assignmentImportService.isCloud ? cloudId.current : item.id }) } finally { setSaving(false) } }
  const chooseKind = (kind: ProviderInput['kind']) => setItem(current => ({ ...current, kind, base_url: kind === 'custom' ? current.base_url : providerPresets[kind].base_url, model: kind === 'custom' ? current.model : providerPresets[kind].model }))
  return <Modal title={item.id ? '编辑 AI 服务商' : '添加 AI 服务商'} onClose={onClose} wide footer={<><button className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" disabled={saving || !item.name.trim() || !item.model.trim() || !item.base_url.trim()} onClick={() => void save()}>{saving ? '保存中…' : '保存服务商'}</button></>}><div className="form-grid"><label className="form-field">名称<input value={item.name} onChange={e => setItem({ ...item,name:e.target.value })} placeholder="例如 百炼-作业识别" /></label><label className="form-field">类型<select value={item.kind} onChange={e => chooseKind(e.target.value as ProviderInput['kind'])}><option value="bailian">阿里云百炼</option><option value="deepseek">DeepSeek</option><option value="gemini">Google Gemini</option><option value="custom">自定义兼容接口</option></select></label><label className="form-field span-2">API Base URL<input value={item.base_url} onChange={e => setItem({ ...item,base_url:e.target.value })} placeholder="https://…/v1" /></label><label className="form-field">模型名称<input value={item.model} onChange={e => setItem({ ...item,model:e.target.value })} placeholder="例如 qwen3.8-max" /></label>{assignmentImportService.isDesktop || assignmentImportService.isCloud ? <label className="form-field">API Key <small>{item.has_key ? '已配置，留空保留原密钥' : '可在这里填写'}</small><input type="password" value={item.api_key} onChange={e => setItem({ ...item,api_key:e.target.value })} autoComplete="new-password" spellCheck={false} maxLength={4096} placeholder={assignmentImportService.isDesktop ? '仅保存到系统安全凭据存储' : '加密保存到个人云端，不会回显'} /></label> : <p className="helper-text">浏览器演示只保存服务商资料，不接收 API Key。</p>}</div><div className="provider-info"><ShieldCheck size={18} /><span>百炼 PDF 需要支持 PDF 理解的模型；DOCX 需要 qwen-long 或 qwen-doc-turbo。DeepSeek 支持文字和视觉模型的图片输入，不支持原始 PDF 或 DOCX。Gemini 使用原生 API，支持文字、图片和 PDF；当前模块不传入 DOCX。自定义接口默认只按文字、图片能力调用；服务端不支持时会显示错误。</span></div></Modal>
}
