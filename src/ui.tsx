import type { ReactNode } from 'react'
import { AlertCircle, CheckCircle2, ChevronRight, Clock3, ExternalLink, File, FileText, History, Pencil, Plus, Trash2, X } from 'lucide-react'
import { service } from './service'
import { roleLabels, statusLabels } from './types'
import type { Assignment, Course, FileAsset, FileHistoryEvent, FileLink, FileRole, Status } from './types'

export function errorText(error: unknown) { return error instanceof Error ? error.message : String(error) }
export function fileName(path: string) { return path.split(/[\\/]/).at(-1) || path }
export function dateLabel(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
export function fullDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
export function dueState(item: Assignment) {
  if (!item.due_at || item.status === 'submitted') return 'none'
  const diff = new Date(item.due_at).getTime() - Date.now()
  if (diff < 0) return 'overdue'
  if (diff < 86400000) return 'today'
  if (diff < 7 * 86400000) return 'soon'
  return 'later'
}
export function isOpen(item: Assignment) { return item.status !== 'submitted' }
export function urlIsSafe(value: string) { try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false } }

export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button></header>
      <div className="modal-body">{children}</div>
      {footer ? <footer className="modal-footer">{footer}</footer> : null}
    </section>
  </div>
}

export function AssignmentTable({ items, courses, selectedId, onSelect, filesFor }: { items: Assignment[]; courses: Course[]; selectedId: string; onSelect: (id: string) => void; filesFor: (id: string) => number }) {
  return <div className="assignment-table-wrap"><table className="assignment-table"><thead><tr><th>作业</th><th>科目</th><th>截止时间</th><th>状态</th><th>提交位置</th><th>文件</th><th /></tr></thead><tbody>{items.map(item => <tr key={item.id} className={selectedId === item.id ? 'selected' : ''} onClick={() => onSelect(item.id)}><td><div className="table-title"><FileText size={20} strokeWidth={1.8} /><span>{item.title}</span></div></td><td>{courses.find(c => c.id === item.course_id)?.name || '—'}</td><td><span className={dueState(item) === 'overdue' ? 'date-overdue' : ''}>{dateLabel(item.due_at)}</span></td><td><span className={`status status-${item.status}`}>{statusLabels[item.status]}</span></td><td>{item.submission_label || <span className="muted">—</span>}</td><td>{filesFor(item.id) ? `${filesFor(item.id)} 个文件` : <span className="muted">—</span>}</td><td><ChevronRight size={16} /></td></tr>)}</tbody></table>{items.length === 0 ? <div className="empty-list"><CheckCircle2 size={29} /><strong>这里暂时没有作业</strong><span>新建作业后，会按截止时间显示在这里。</span></div> : null}</div>
}

function LinkedFile({ link, file, onEdit, onRename, onRelink }: { link: FileLink; file?: FileAsset; onEdit: () => void; onRename: () => void; onRelink: () => void }) {
  return <div className={`linked-file ${file?.missing ? 'linked-file-missing' : ''}`}><div className="file-glyph"><File size={18} /></div><div className="linked-file-info"><button className="text-link file-name-link" onClick={() => { if (file && !file.missing) void service.openFile(file.id).catch(e => window.alert(`打开文件失败：${errorText(e)}`)) }} disabled={!file || file.missing}>{file ? fileName(file.path) : '未知文件'}{!file?.missing ? <ExternalLink size={13} /> : null}</button><small>{roleLabels[link.role]}{link.page ? ` · p.${link.page}` : ''}{link.chapter ? ` · ${link.chapter}` : ''}{link.problem ? ` · 第 ${link.problem} 题` : ''}</small>{file?.missing ? <span className="danger-text">文件未找到</span> : null}</div><div className="file-actions"><button className="icon-button tiny" onClick={file?.missing ? onRelink : onEdit} title={file?.missing ? '重新定位' : '编辑关联'}><Pencil size={15} /></button><button className="icon-button tiny" onClick={onRename} title="统一命名"><FileText size={15} /></button></div></div>
}

export function AssignmentDetail({ item, course, links, files, fileHistory, onEdit, onDelete, onAddFile, onEditLink, onRename, onStatus, onRelink }: { item: Assignment; course?: Course; links: FileLink[]; files: FileAsset[]; fileHistory: FileHistoryEvent[]; onEdit: () => void; onDelete: () => void; onAddFile: (role: FileRole) => void; onEditLink: (link: FileLink) => void; onRename: (link: FileLink) => void; onStatus: (status: Status) => void; onRelink: (file: FileAsset) => void }) {
  const grouped = (role: FileRole) => links.filter(l => l.role === role)
  const fileRow = (link: FileLink) => <LinkedFile key={link.id} link={link} file={files.find(f => f.id === link.file_id)} onEdit={() => onEditLink(link)} onRename={() => onRename(link)} onRelink={() => { const file = files.find(f => f.id === link.file_id); if (file) onRelink(file) }} />
  const historyLabels: Record<string,string> = { tracking_started:'开始追踪', content_changed:'文件内容变化', linked:'关联文件', link_updated:'更新关联', unlinked:'取消关联', common_added:'设为常用文件', common_updated:'更新常用文件', common_removed:'取消常用文件', relocated:'重新定位', renamed:'文件改名', rename_undone:'撤回改名' }
  const roleForFile = (fileId: string): FileRole | 'other' => {
    const current = links.find(link => link.file_id === fileId)?.role
    if (current) return current
    const details = fileHistory.find(event => event.file_id === fileId && event.assignment_id === item.id && event.details.includes('角色：'))?.details || ''
    if (details.includes('我的解答')) return 'solution'
    if (details.includes('教材参考')) return 'reference'
    if (details.includes('题目材料')) return 'prompt'
    return 'other'
  }
  const historyGroups = [
    { key:'solution', label:'我的解答', events:fileHistory.filter(event => roleForFile(event.file_id) === 'solution') },
    { key:'materials', label:'题目与参考', events:fileHistory.filter(event => ['prompt','reference'].includes(roleForFile(event.file_id))) },
    { key:'other', label:'其他文件', events:fileHistory.filter(event => roleForFile(event.file_id) === 'other') },
  ].filter(group => group.events.length)
  return <section className="detail-panel"><div className="detail-heading"><div className="detail-title"><div className="detail-icon"><FileText size={24} /></div><div><h2>{item.title}</h2><p>{course?.name || '未匹配课程'}</p></div></div><div className="detail-actions"><select className={`status-select status-${item.status}`} value={item.status} onChange={event => onStatus(event.target.value as Status)} aria-label="作业状态">{Object.entries(statusLabels).map(([key,value]) => <option value={key} key={key}>{value}</option>)}</select><button className="icon-button" onClick={onEdit} title="编辑作业"><Pencil size={17} /></button><button className="icon-button danger-hover" onClick={onDelete} title="删除作业"><Trash2 size={17} /></button></div></div>
    <div className="detail-columns"><div className="detail-column"><h3>截止与提交</h3><div className="detail-field"><Clock3 size={18} /><div><small>截止时间</small><span>{fullDate(item.due_at)}{dueState(item) === 'overdue' ? <em className="danger-text"> · 已逾期</em> : null}</span></div></div><div className="detail-field"><ExternalLink size={18} /><div><small>提交到</small>{item.submission_url && urlIsSafe(item.submission_url) ? <button className="text-link" onClick={() => service.openUrl(item.submission_url)}>{item.submission_label || item.submission_url}<ExternalLink size={14} /></button> : <span>{item.submission_label || '—'}</span>}</div></div>{item.submission_notes ? <div className="detail-field"><FileText size={18} /><div><small>提交要求</small><span>{item.submission_notes}</span></div></div> : null}</div>
      <div className="detail-column"><h3>题目材料</h3>{[...grouped('prompt'), ...grouped('reference')].map(fileRow)}{!grouped('prompt').length && !grouped('reference').length ? <p className="detail-empty">尚未关联题目或教材</p> : null}<button className="add-inline" onClick={() => onAddFile('prompt')}><Plus size={16} />添加材料</button></div><div className="detail-column"><h3>我的解答</h3>{grouped('solution').map(fileRow)}{!grouped('solution').length ? <p className="detail-empty">尚未关联解答文件</p> : null}<button className="add-inline" onClick={() => onAddFile('solution')}><Plus size={16} />添加解答</button></div></div>
    {item.description ? <div className="detail-notes"><h3>作业说明</h3><p>{item.description}</p></div> : null}{Object.keys(item.custom_fields || {}).length ? <div className="detail-notes"><h3>自定义字段</h3><dl className="custom-detail-list">{Object.entries(item.custom_fields).map(([key,value]) => <div key={key}><dt>{key}</dt><dd>{value || "—"}</dd></div>)}</dl></div> : null}<details className="assignment-file-history"><summary><History size={16} /><span>作业文件历史</span><em>{fileHistory.length} 条</em></summary>{historyGroups.length ? <div className="assignment-history-groups">{historyGroups.map(group => <section key={group.key}><h4>{group.label}</h4>{group.events.slice(0,30).map(event => { const asset = files.find(file => file.id === event.file_id); return <div className="assignment-history-row" key={event.id}><span className={`file-history-dot event-${event.event_type}`} /><div><div><strong>{historyLabels[event.event_type] || event.event_type}</strong><time>{fullDate(event.occurred_at)}</time></div><button className="assignment-history-file" title={asset?.path || event.path} disabled={!asset || asset.missing} onClick={() => { if (asset) void service.openFile(asset.id).catch(error => window.alert(`打开文件失败：${errorText(error)}`)) }}>{fileName(event.path)}</button>{event.details ? <small>{event.details}</small> : null}</div></div> })}</section>)}</div> : <div className="history-empty">尚无文件历史；关联解答或题目文件后会开始记录。</div>}</details>{item.source_name || item.source_text ? <details className="source-detail"><summary>来源内容 {item.source_name ? `· ${item.source_name}` : ''}</summary><p>{item.source_text || '没有保存来源原文'}</p></details> : null}</section>
}

export function InlineError({ children }: { children: ReactNode }) { return <div className="inline-error"><AlertCircle size={16} />{children}</div> }
