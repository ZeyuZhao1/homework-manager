import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, ChevronDown, ChevronUp, ExternalLink, FileText, Folder, FolderOpen, History, Link2, Pencil, Plus, RotateCcw, Search, Trash2, Upload } from 'lucide-react'
import { service } from './service'
import { roleLabels } from './types'
import type { Course, FileAsset, ModuleDescriptor, Settings, Snapshot } from './types'
import { appModules } from './moduleRegistry'
import { PrintSettingsDialog } from './printing'
import { errorText, fileName, fullDate } from './ui'
import { attachmentName, attachmentLocation, canOpenAttachment, isCloudReference } from './filePresentation'
import { SyncSettings } from './sync/SyncSettings'
import './mobileSurfaces.css'
import './fileRelations.css'
import { FileTransferActions } from './sync/FileTransferActions'

function FileRelations({ file, snapshot, courseIds, onOpenAssignment }: { file: FileAsset; snapshot: Snapshot; courseIds: string[]; onOpenAssignment: (id: string) => void }) {
  const links = snapshot.links.filter(link => link.file_id === file.id)
  const moduleLinks = snapshot.module_file_links.filter(link => link.file_id === file.id)
  const commonFiles = snapshot.common_files.filter(item => item.file_id === file.id)
  const courses = snapshot.courses.filter(course => courseIds.includes(course.id))
  const assignmentCount = new Set(links.map(link => link.assignment_id)).size
  const courseSummary = courses.length > 1 ? `${courses[0].name} 等 ${courses.length} 门科目` : courses[0]?.name
  const relationSummary = [assignmentCount ? `${assignmentCount} 个作业` : '', moduleLinks.length ? `${moduleLinks.length} 个周期任务` : '', commonFiles.length ? '常用文件' : ''].filter(Boolean).join(' · ')
  return <details className="file-relation-details">
    <summary>
      <span className="file-relation-summary-text">{courseSummary ? <span className="file-relation-course">{courseSummary}</span> : null}<span>{relationSummary || '文件详情'}</span></span>
      <ChevronDown size={14} aria-hidden="true" />
    </summary>
    <div className="file-relation-content">
      {courses.length ? <div className="file-relation-courses">{courses.map(course => <span key={course.id}>{course.name}</span>)}</div> : null}
      {links.length ? <div className="file-relation-links">{links.map(link => <button className="file-relation-assignment" key={link.id} onClick={() => onOpenAssignment(link.assignment_id)}>
        <span className="file-relation-assignment-main"><span className="file-relation-assignment-title">{snapshot.assignments.find(assignment => assignment.id === link.assignment_id)?.title || '未知作业'}</span><span className="file-relation-role">{roleLabels[link.role]}</span></span>
        {[link.chapter, link.page ? `第 ${link.page} 页` : '', link.problem ? `题号 ${link.problem}` : '', link.note].filter(Boolean).length ? <span className="file-relation-note">{[link.chapter, link.page ? `第 ${link.page} 页` : '', link.problem ? `题号 ${link.problem}` : '', link.note].filter(Boolean).join(' · ')}</span> : null}
        <ChevronRight size={15} aria-hidden="true" />
      </button>)}</div> : null}
      {moduleLinks.map(link => <p className="file-relation-owner" key={link.id}>周期任务 · {link.owner_label}{link.note ? ` · ${link.note}` : ''}</p>)}
      {commonFiles.map(item => <p className="file-relation-owner" key={item.course_id}>常用文件{item.label ? ` · ${item.label}` : ''}</p>)}
      {!links.length && !moduleLinks.length && !commonFiles.length ? <p className="file-relation-owner">暂无当前关联，文件记录仍保留。</p> : null}
      <div className="file-relation-location"><span>文件位置</span><p>{attachmentLocation(file)}</p></div>
    </div>
  </details>
}

export function FilesPage({ snapshot, onRelink, onOpenAssignment, onUndo }: { snapshot: Snapshot; onRelink: (file: FileAsset) => void; onOpenAssignment: (id: string) => void; onUndo: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [missingOnly, setMissingOnly] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [courseFilter, setCourseFilter] = useState('')
  const [historyFileId, setHistoryFileId] = useState('')
  const usedFiles = snapshot.files.filter(file => service.isCloud || snapshot.links.some(link => link.file_id === file.id) || snapshot.module_file_links.some(link => link.file_id === file.id) || snapshot.common_files.some(item => item.file_id === file.id) || snapshot.file_history.some(event => event.file_id === file.id)).map(file => { const owners=snapshot.module_file_links.filter(link=>link.file_id===file.id).map(link=>`周期任务 · ${link.owner_label}`); return {...file,owners:owners.join('、')} })
  const courseIds = (id: string) => [...new Set([...snapshot.common_files.filter(item => item.file_id === id).map(item => item.course_id), ...snapshot.links.filter(link => link.file_id === id).map(link => snapshot.assignments.find(item => item.id === link.assignment_id)?.course_id || '')])]
  const typeOf = (path: string) => { const ext = path.split(' · ')[0].split('.').at(-1)?.toLowerCase(); return ext === 'pdf' ? 'pdf' : ['doc','docx'].includes(ext || '') ? 'word' : ['png','jpg','jpeg','webp','gif','bmp','tif','tiff'].includes(ext || '') ? 'image' : 'other' }
  const visible = usedFiles.filter(file => (!missingOnly || file.missing) && (!typeFilter || typeOf(attachmentName(file)) === typeFilter) && (!courseFilter || courseIds(file.id).includes(courseFilter)) && `${attachmentName(file)} ${isCloudReference(file.path) ? '' : file.path} ${file.owners}`.toLowerCase().includes(query.toLowerCase()))
  const eventLabels: Record<string,string> = { tracking_started:'开始追踪', content_changed:'检测到文件变化', linked:'关联到作业', link_updated:'更新关联信息', unlinked:'移除关联', common_added:'设为常用文件', common_updated:'更新常用文件', common_removed:'取消常用文件', module_linked:'关联到周期任务', module_unlinked:'取消周期关联', relocated:'重新定位', renamed:'文件改名', rename_undone:'撤回改名' }
  const sizeLabel = (size: number | null) => size === null ? '' : size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`
  return <><div className="page-header"><div><h1>文件</h1><p>{usedFiles.length} 个文件 · {usedFiles.filter(f => f.missing).length} 个链接待修复</p></div></div><div className="file-page-toolbar"><div className="search-field"><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索文件名或路径" /></div><select aria-label="按文件类型筛选" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}><option value="">全部类型</option><option value="pdf">PDF</option><option value="word">Word 文档</option><option value="image">图片</option><option value="other">其他</option></select><select aria-label="按科目筛选" value={courseFilter} onChange={e => setCourseFilter(e.target.value)}><option value="">全部科目</option>{snapshot.courses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}</select><label className="checkbox-label"><input type="checkbox" checked={missingOnly} onChange={e => setMissingOnly(e.target.checked)} />仅显示失效链接</label></div><div className="file-page-list">{visible.map(file => { const events = snapshot.file_history.filter(event => event.file_id === file.id); const expanded = historyFileId === file.id; return <div className="file-page-item" key={file.id}><div className="file-page-row"><div className={`file-page-icon ${file.missing ? 'missing' : ''}`}><FileText size={21} /></div><div className="file-page-main"><strong>{attachmentName(file)}</strong><small title={attachmentLocation(file)}>{attachmentLocation(file)}</small><FileRelations file={file} snapshot={snapshot} courseIds={courseIds(file.id)} onOpenAssignment={onOpenAssignment} /></div><div className="file-page-actions"><FileTransferActions file={file} /><button className="button button-quiet file-history-toggle" onClick={() => setHistoryFileId(expanded ? '' : file.id)} title="查看文件历史"><History size={16} />历史 {events.length}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>{file.missing ? <button className="button button-quiet" onClick={() => onRelink(file)}><Link2 size={16} />{isCloudReference(file.path) ? "关联本机文件" : "重新定位"}</button> : <button className="icon-button" disabled={!canOpenAttachment(file, service.isCloud)} onClick={() => { void service.openFile(file.id).catch(e => window.alert(`打开文件失败：${errorText(e)}`)) }} title={canOpenAttachment(file, service.isCloud) ? "打开文件" : file.cloud_available ? "请先下载到本机" : "仅元数据，尚未上传内容"}><ExternalLink size={17} /></button>}</div></div>{expanded ? <div className="file-history-panel">{events.map(event => <div className="file-history-event" key={event.id}><span className={`file-history-dot event-${event.event_type}`} /><div><div className="file-history-heading"><strong>{eventLabels[event.event_type] || event.event_type}</strong><time>{fullDate(event.occurred_at)}</time></div>{event.assignment_title ? snapshot.assignments.some(item => item.id === event.assignment_id) ? <button className="text-link" onClick={() => onOpenAssignment(event.assignment_id)}>{event.assignment_title}</button> : <span className="muted">曾关联：{event.assignment_title}</span> : null}{event.details ? <p>{event.details}</p> : null}<small title={fileName(event.path)}>{fileName(event.path)}{event.file_size !== null ? ` · ${sizeLabel(event.file_size)}` : ''}</small></div></div>)}{!events.length ? <div className="history-empty">尚无历史记录；下一次关联或文件操作会开始记录。</div> : null}</div> : null}</div> })}{!visible.length ? <div className="empty-list"><FolderOpen size={30} /><strong>没有找到关联文件</strong><span>在作业详情中添加题目材料或解答。</span></div> : null}</div>{service.isDesktop ? <section className="history-section"><h2>可撤回的改名</h2><p>只有最近一次仍有效的改名可以撤回；文件被外部修改后会阻止撤回。</p>{snapshot.renames.map(event => <div className="history-row" key={event.id}><RotateCcw size={17} /><div><strong>{fileName(event.new_path)}</strong><small>原名：{fileName(event.old_path)} · {fullDate(event.changed_at)}</small></div>{event.undone_at ? <span className="muted">已撤回</span> : <button className="button button-quiet" onClick={() => onUndo(event.id)}>撤回</button>}</div>)}{!snapshot.renames.length ? <div className="history-empty">尚无改名记录</div> : null}</section> : null}</>
}

const phoneQuery = '(max-width: 780px)'
const subscribePhone = (notify: () => void) => { const query = window.matchMedia(phoneQuery); query.addEventListener('change', notify); return () => query.removeEventListener('change', notify) }
function MobileSettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const mobile = useSyncExternalStore(subscribePhone, () => window.matchMedia(phoneQuery).matches, () => false)
  if (!mobile) return children
  return <details className="mobile-setting-section"><summary><span>{title}<small>{description}</small></span><ChevronRight size={18} /></summary><div>{children}</div></details>
}

export function SettingsPage({ snapshot, onSaveSettings, onEditCourse, onAddSemester, onDeleteSemester, onBackup, onRestore }: { snapshot: Snapshot; onSaveSettings: (value: Settings) => void; onEditCourse: (course: Course) => void; onAddSemester: () => void; onDeleteSemester: (semesterId: string) => void; onBackup: () => void; onRestore: () => void }) {
  const [settings, setSettings] = useState(snapshot.settings)
  const [modules, setModules] = useState<ModuleDescriptor[]>([])
  const [modulePath, setModulePath] = useState('')
  const [moduleBusy, setModuleBusy] = useState('')
  const [printingModuleId, setPrintingModuleId] = useState('')
  useEffect(() => setSettings(snapshot.settings), [snapshot.settings])
  useEffect(() => { void service.modulesDirectory().then(setModulePath).catch(() => {}); void service.listModules(appModules.map(module => module.descriptor)).then(setModules).catch(() => {}) }, [])
  const update = (patch: Partial<Settings>) => setSettings(current => ({ ...current, ...patch }))
  const setEnabled = async (moduleId: string, enabled: boolean) => {
    setModuleBusy(moduleId)
    try {
      await service.setModuleEnabled(moduleId, enabled)
      setModules(current => current.map(module => module.id === moduleId ? { ...module, enabled } : module))
      window.dispatchEvent(new CustomEvent('homeworkbook:module-state-changed'))
    } catch (error) { window.alert(`切换模块失败：${errorText(error)}`) }
    finally { setModuleBusy('') }
  }
  const printingModule = modules.find(module => module.id === printingModuleId && module.enabled)
  return <><div className="page-header"><div><h1>设置</h1><p>管理课程目录、命名规则、功能模块、云端模型和数据库备份</p></div></div><div className="settings-layout"><div className="settings-column"><MobileSettingsSection title="个人多设备同步" description="连接设备、管理授权与身份恢复"><SyncSettings /></MobileSettingsSection><section className="settings-card"><div className="settings-card-title"><div><h2>外观与文件命名</h2><p>只影响应用显示和手动执行的原地重命名。</p></div></div><div className="form-grid"><label className="form-field">界面主题<select value={settings.theme} onChange={e => update({ theme:e.target.value as Settings['theme'] })}><option value="light">浅色</option><option value="dark">中性深灰</option></select></label>{service.isDesktop ? <label className="form-field span-2">命名模板<input value={settings.naming_template} onChange={e => update({ naming_template:e.target.value })} /></label> : null}</div>{service.isDesktop ? <p className="helper-text">可用字段：{'{course_code}'}、{'{material}'}、{'{scope}'}（s 节或 ch 章）；兼容 {'{sections}'}；也兼容 {'{semester}'}、{'{course}'}、{'{assignment}'}、{'{role}'}、{'{version}'}。原文件扩展名会保留。</p> : null}<button className="button button-primary" onClick={() => onSaveSettings(settings)}>保存设置</button></section>
    <section className="settings-card"><div className="settings-card-title"><div><h2>学期与课程目录</h2><p>文件仍在原位置；目录用于按课程浏览和搜索。</p></div><button className="button button-quiet" onClick={onAddSemester}><Plus size={16} />添加学期</button></div>{snapshot.semesters.map(semester => <div className="semester-settings" key={semester.id}><div className="semester-settings-heading"><div><strong>{semester.name}</strong><small>{semester.source_root || '未关联学期根目录'}</small></div><button className="button button-quiet mobile-add-course" onClick={() => onEditCourse({ id: '', semester_id: semester.id, name: '', code: '', folder_path: '' })}><Plus size={15} />课程</button><button className="icon-button danger-hover" onClick={() => onDeleteSemester(semester.id)} disabled={snapshot.semesters.length <= 1} title={snapshot.semesters.length <= 1 ? '至少保留一个学期' : `删除 ${semester.name}`}><Trash2 size={16} /></button></div>{snapshot.courses.filter(c => c.semester_id === semester.id).map(course => <button key={course.id} className="course-settings-row" onClick={() => onEditCourse(course)}><Folder size={17} /><span>{course.name}<small>{course.folder_path || '未关联文件夹'}</small></span><Pencil size={15} /></button>)}</div>)}</section>
    {service.isDesktop ? <section className="settings-card"><div className="settings-card-title"><div><h2>数据库备份</h2><p>备份作业、关联路径、文件历史、模块开关、常用文件、自定义字段和设置；不包含实际文件、提示词文件或 API 密钥。</p></div></div><div className="backup-buttons"><button className="button button-quiet" onClick={onBackup}><Upload size={16} />导出备份</button><button className="button button-quiet" onClick={onRestore}><RotateCcw size={16} />从备份恢复</button><button className="button button-quiet" onClick={() => { void service.compactDatabase().then(() => window.alert("数据库已压缩")).catch(e => window.alert(`压缩失败：${errorText(e)}`)) }}>压缩数据库</button></div></section> : null}</div><div className="settings-column">{appModules.map(module => { const descriptor = modules.find(item => item.id === module.id); const enabled = descriptor?.enabled ?? false; return <MobileSettingsSection key={module.id} title={module.descriptor.name} description={enabled ? "已开启 · 点击管理" : "未开启 · 点击设置"}><module.SettingsCard enabled={enabled} snapshot={snapshot} onToggle={next => { if (descriptor && moduleBusy !== module.id) void setEnabled(module.id,next) }} /></MobileSettingsSection> })}
{service.isDesktop ? <section className="settings-card"><div className="settings-card-title"><div><h2>其他功能模块</h2><p>没有专属设置界面的模块在这里管理；关闭后主程序会拒绝调用。</p></div></div>{modules.filter(module => !appModules.some(item => item.id === module.id)).map(module => <div className="module-row" key={module.id}><div><strong>{module.name} · {module.builtin ? "内置" : "外部"}</strong><small>v{module.version} · {module.capabilities.join("、")}</small>{!module.builtin && module.capabilities.includes('file.print.configure') ? <button className="button button-quiet" disabled={!module.enabled || moduleBusy === module.id} onClick={() => setPrintingModuleId(module.id)}>打印设置</button> : null}</div><button className={`module-toggle ${module.enabled ? 'enabled' : ''}`} role="switch" aria-checked={module.enabled} disabled={moduleBusy === module.id} onClick={() => { void setEnabled(module.id,!module.enabled) }}><span />{module.enabled ? '已开启':'已关闭'}</button></div>)}{!modules.filter(module => !appModules.some(item => item.id === module.id)).length ? <div className="settings-empty">当前没有其他模块。</div> : null}<p className="helper-text">模块目录：{modulePath || "加载中…"}</p><div className="backup-buttons"><button className="button button-quiet" onClick={() => { void service.openModulesDirectory().catch(e => window.alert(errorText(e))) }}><FolderOpen size={16} />打开模块目录</button><button className="button button-quiet" onClick={() => { void service.listModules(appModules.map(module => module.descriptor)).then(items => { setModules(items); window.dispatchEvent(new CustomEvent('homeworkbook:module-state-changed')) }).catch(e => window.alert(errorText(e))) }}>刷新模块</button></div></section> : null}</div></div>{printingModule ? <PrintSettingsDialog key={printingModule.id} module={printingModule} onClose={() => setPrintingModuleId('')} /> : null}</>
}
