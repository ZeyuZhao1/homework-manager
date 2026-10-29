import { useRef, useState } from 'react'
import { service } from './service'
import type { Course, Semester } from './types'
import { errorText, InlineError, Modal } from './ui'

export function CourseEditor({ initial, semesters, onClose, onSave }: { initial: Course; semesters: Semester[]; onClose: () => void; onSave: (value: Course) => Promise<void> }) {
  const [item, setItem] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const pick = async () => {
    if (working.current) return
    working.current = true; setPicking(true); setError('')
    try { const path = await service.pickDirectory(); if (path) setItem(current => ({ ...current, folder_path: path })) }
    catch (reason) { setError(errorText(reason)) }
    finally { working.current = false; setPicking(false) }
  }
  const save = async () => {
    if (working.current || !item.name.trim()) return
    working.current = true; setSaving(true); setError('')
    try { await onSave(item) }
    catch (reason) { setError(errorText(reason)) }
    finally { working.current = false; setSaving(false) }
  }
  return <Modal title={item.id ? '编辑课程' : '添加课程'} onClose={onClose} footer={<><button className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" disabled={!item.name.trim() || saving || picking} onClick={() => void save()}>{saving ? '保存中…' : '保存课程'}</button></>}>
    <div className="form-grid">
      <label className="form-field span-2">课程名称<input value={item.name} onChange={e => setItem({ ...item, name: e.target.value })} /></label>
      <label className="form-field">课程代码 <small>可留空</small><input value={item.code} onChange={e => setItem({ ...item, code: e.target.value })} /></label>
      <label className="form-field">所属学期<select value={item.semester_id} onChange={e => setItem({ ...item, semester_id: e.target.value })}>{semesters.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></label>
      <label className="form-field span-2">课程文件夹<div className="input-with-button"><input value={item.folder_path} onChange={e => setItem({ ...item, folder_path: e.target.value })} placeholder="可以暂时留空" /><button className="button button-quiet" disabled={saving || picking} onClick={() => void pick()}>{picking ? '选择中…' : '选择'}</button></div></label>
    </div>
    {error ? <InlineError>{error}</InlineError> : null}
  </Modal>
}

export function SemesterEditor({ initial, onClose, onSave }: { initial: Semester; onClose: () => void; onSave: (value: Semester) => Promise<void> }) {
  const [item, setItem] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const working = useRef(false)
  const pick = async () => {
    if (working.current) return
    working.current = true; setPicking(true); setError('')
    try { const path = await service.pickDirectory(); if (path) setItem(current => ({ ...current, source_root: path })) }
    catch (reason) { setError(errorText(reason)) }
    finally { working.current = false; setPicking(false) }
  }
  const save = async () => {
    if (working.current || !item.name.trim()) return
    working.current = true; setSaving(true); setError('')
    try { await onSave(item) }
    catch (reason) { setError(errorText(reason)) }
    finally { working.current = false; setSaving(false) }
  }
  return <Modal title={item.id ? '编辑学期' : '添加学期'} onClose={onClose} footer={<><button className="button button-quiet" onClick={onClose}>取消</button><button className="button button-primary" disabled={!item.name.trim() || saving || picking} onClick={() => void save()}>{saving ? '保存中…' : '保存学期'}</button></>}>
    <div className="form-grid">
      <label className="form-field span-2">学期名称<input value={item.name} onChange={e => setItem({ ...item, name: e.target.value })} placeholder="例如 2027 春季" /></label>
      <label className="form-field span-2">资料根目录 <small>可留空</small><div className="input-with-button"><input value={item.source_root} onChange={e => setItem({ ...item, source_root: e.target.value })} /><button className="button button-quiet" disabled={saving || picking} onClick={() => void pick()}>{picking ? '选择中…' : '选择'}</button></div></label>
    </div>
    {error ? <InlineError>{error}</InlineError> : null}
  </Modal>
}
