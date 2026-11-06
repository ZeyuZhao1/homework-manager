import { useRef, useState } from 'react'
import { service } from './service'
import type { Course, Semester } from './types'
import { errorText, InlineError, Modal } from './ui'

function useEditorRequest(onClose: () => void) {
  const requestActive = useRef(false)
  const [busy, setBusy] = useState<'save' | 'pick' | null>(null)
  const [error, setError] = useState('')
  const run = async (kind: 'save' | 'pick', work: () => Promise<void>) => {
    if (requestActive.current) return
    requestActive.current = true
    setBusy(kind)
    setError('')
    try { await work() } catch (e) { setError(errorText(e)) } finally { requestActive.current = false; setBusy(null) }
  }
  const close = () => { if (!requestActive.current) onClose() }
  return { busy, error, run, close }
}

export function CourseEditor({ initial, semesters, onClose, onSave }: { initial: Course; semesters: Semester[]; onClose: () => void; onSave: (value: Course) => Promise<void> }) {
  const [item, setItem] = useState(initial)
  const { busy, error, run, close } = useEditorRequest(onClose)
  const pick = () => run('pick', async () => { const path = await service.pickDirectory(); if (path) setItem(current => ({ ...current, folder_path:path })) })
  return <Modal title={item.id ? '编辑课程' : '添加课程'} onClose={close} closeDisabled={!!busy} footer={<><button className="button button-quiet" disabled={!!busy} onClick={close}>取消</button><button className="button button-primary" disabled={!item.name.trim() || !!busy} onClick={() => void run('save', () => onSave(item))}>{busy === 'save' ? '保存中…' : '保存课程'}</button></>}>
    <fieldset className="dialog-fields" disabled={!!busy}><div className="form-grid"><label className="form-field span-2">课程名称<input value={item.name} onChange={e => setItem({ ...item,name:e.target.value })} /></label><label className="form-field">课程代码 <small>可留空</small><input value={item.code} onChange={e => setItem({ ...item,code:e.target.value })} /></label><label className="form-field">所属学期<select value={item.semester_id} onChange={e => setItem({ ...item,semester_id:e.target.value })}>{semesters.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></label>{!service.isCloud ? <label className="form-field span-2">课程文件夹<div className="input-with-button"><input value={item.folder_path} onChange={e => setItem({ ...item,folder_path:e.target.value })} placeholder="可以暂时留空" /><button className="button button-quiet" onClick={() => void pick()}>{busy === 'pick' ? '选择中…' : '选择'}</button></div></label> : null}</div></fieldset>
    {error ? <InlineError>{error}</InlineError> : null}
  </Modal>
}

export function SemesterEditor({ initial, onClose, onSave }: { initial: Semester; onClose: () => void; onSave: (value: Semester) => Promise<void> }) {
  const [item,setItem] = useState(initial)
  const { busy, error, run, close } = useEditorRequest(onClose)
  const pick = () => run('pick', async () => { const path = await service.pickDirectory(); if (path) setItem(current => ({ ...current, source_root:path })) })
  return <Modal title="添加学期" onClose={close} closeDisabled={!!busy} footer={<><button className="button button-quiet" disabled={!!busy} onClick={close}>取消</button><button className="button button-primary" disabled={!item.name.trim() || !!busy} onClick={() => void run('save', () => onSave(item))}>{busy === 'save' ? '保存中…' : '保存学期'}</button></>}>
    <fieldset className="dialog-fields" disabled={!!busy}><label className="form-field">学期名称<input value={item.name} onChange={e => setItem({ ...item,name:e.target.value })} placeholder="例如 2027 春季" /></label>{!service.isCloud ? <label className="form-field">资料根目录 <small>可留空</small><div className="input-with-button"><input value={item.source_root} onChange={e => setItem({ ...item,source_root:e.target.value })} /><button className="button button-quiet" onClick={() => void pick()}>{busy === 'pick' ? '选择中…' : '选择'}</button></div></label> : null}</fieldset>
    {error ? <InlineError>{error}</InlineError> : null}
  </Modal>
}
