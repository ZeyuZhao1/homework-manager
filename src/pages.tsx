import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight, ChevronDown, ChevronUp, ExternalLink, FileText, Folder, FolderOpen, History, Link2, Pencil, Plus, RotateCcw, Search, Trash2, Upload } from 'lucide-react'
import { service } from './service'
import { roleLabels } from './types'
import type { Course, FileAsset, ModuleDescriptor, Settings, Snapshot } from './types'
import { appModules } from './moduleRegistry'
import { PrintSettingsDialog } from './printing'
import { errorText, fileName, fullDate } from './ui'
import { attachmentName, attachmentLocation, canOpenAttachment, isCloudReference, isDriveReference } from './filePresentation'
import { driveService } from './drive/service'
import { DriveSettings } from './drive/DriveControls'
import { SyncSettings } from './sync/SyncSettings'
import './mobileSurfaces.css'
import './fileRelations.css'
import './workspacePages.css'
import { FileTransferActions } from './sync/FileTransferActions'

type FileIndex = { links: Snapshot['links']; moduleLinks: Snapshot['module_file_links']; commonFiles: Snapshot['common_files']; events: Snapshot['file_history']; courses: Course[]; courseIds: Set<string> }

function FileRelations({ file, relations, assignments, onOpenAssignment }: { file: FileAsset; relations: FileIndex; assignments: Map<string, Snapshot['assignments'][number]>; onOpenAssignment: (id: string) => void }) {
  const [refreshing, setRefreshing] = useState(false)
  const [driveError, setDriveError] = useState('')
  const refreshingRef = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refreshDrive = async () => {
    if (!isDriveReference(file) || refreshingRef.current) return
    refreshingRef.current = true; setRefreshing(true); setDriveError('')
    try { if (!await driveService.connectedDesktop()) throw new Error('请先在设置中连接个人云端并授权此设备，再刷新 Drive 信息。'); await driveService.refresh(file) }
    catch (reason) { if (alive.current) setDriveError(errorText(reason)) }
    finally { refreshingRef.current = false; if (alive.current) setRefreshing(false) }
  }
  const { links, moduleLinks, commonFiles, courses } = relations
  const assignmentCount = new Set(links.map(link => link.assignment_id)).size
  const courseSummary = courses.length > 1 ? `${courses[0].name} 等 ${courses.length} 门科目` : courses[0]?.name
  const relationSummary = [assignmentCount ? `${assignmentCount} 个作业` : '', moduleLinks.length ? `${moduleLinks.length} 个周期任务` : '', commonFiles.length ? '常用文件' : ''].filter(Boolean).join(' · ')
  return <details className="file-relation-details" onToggle={event => { if (event.currentTarget.open) void refreshDrive() }}>
    <summary>
      <span className="file-relation-summary-text">{courseSummary ? <span className="file-relation-course">{courseSummary}</span> : null}<span>{relationSummary || '文件详情'}</span></span>
      <ChevronDown size={14} aria-hidden="true" />
    </summary>
    <div className="file-relation-content">
      {refreshing ? <small role="status">正在刷新 Google Drive 信息…</small> : null}{driveError ? <p className="drive-error" role="alert">{driveError}</p> : null}
      {courses.length ? <div className="file-relation-courses">{courses.map(course => <span key={course.id}>{course.name}</span>)}</div> : null}
      {links.length ? <div className="file-relation-links">{links.map(link => <button className="file-relation-assignment" key={link.id} onClick={() => onOpenAssignment(link.assignment_id)}>
        <span className="file-relation-assignment-main"><span className="file-relation-assignment-title">{assignments.get(link.assignment_id)?.title || '未知作业'}</span><span className="file-relation-role">{roleLabels[link.role]}</span></span>
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
  const { usedFiles, assignments } = useMemo(() => {
    const assignments = new Map(snapshot.assignments.map(assignment => [assignment.id, assignment]))
    const courseOrder = new Map(snapshot.courses.map((course, index) => [course.id, index]))
    const courseById = new Map(snapshot.courses.map(course => [course.id, course]))
    const fileIndex = new Map<string, FileIndex>()
    const getFile = (id: string) => {
      let entry = fileIndex.get(id)
      if (!entry) { entry = { links: [], moduleLinks: [], commonFiles: [], events: [], courses: [], courseIds: new Set() }; fileIndex.set(id, entry) }
      return entry
    }
    snapshot.links.forEach(link => { const entry = getFile(link.file_id); entry.links.push(link); const courseId = assignments.get(link.assignment_id)?.course_id; if (courseId) entry.courseIds.add(courseId) })
    snapshot.module_file_links.forEach(link => getFile(link.file_id).moduleLinks.push(link))
    snapshot.common_files.forEach(item => { const entry = getFile(item.file_id); entry.commonFiles.push(item); entry.courseIds.add(item.course_id) })
    snapshot.file_history.forEach(event => getFile(event.file_id).events.push(event))
    fileIndex.forEach(entry => { entry.courses = [...entry.courseIds].map(id => courseById.get(id)).filter((course): course is Course => !!course).sort((a, b) => courseOrder.get(a.id)! - courseOrder.get(b.id)!) })
    const usedFiles = snapshot.files.filter(file => service.isCloud || fileIndex.has(file.id)).map(file => {
      const relations = getFile(file.id)
      return { file, relations, owners: relations.moduleLinks.map(link => `周期任务 · ${link.owner_label}`).join('、') }
    })
    return { usedFiles, assignments }
  }, [snapshot])
  const typeOf = (path: string) => { const ext = path.split(' · ')[0].split('.').at(-1)?.toLowerCase(); return ext === 'pdf' ? 'pdf' : ['doc','docx'].includes(ext || '') ? 'word' : ['png','jpg','jpeg','webp','gif','bmp','tif','tiff'].includes(ext || '') ? 'image' : 'other' }
  const needle = query.trim().toLowerCase()
  const hasFilters = !!(needle || missingOnly || typeFilter || courseFilter)
  const visible = usedFiles.filter(({ file, relations, owners }) => (!missingOnly || (isDriveReference(file) ? file.drive_unavailable : file.missing)) && (!typeFilter || typeOf(attachmentName(file)) === typeFilter) && (!courseFilter || relations.courseIds.has(courseFilter)) && `${attachmentName(file)} ${isCloudReference(file.path) || isDriveReference(file) ? '' : file.path} ${owners}`.toLowerCase().includes(needle))
  const eventLabels: Record<string,string> = { tracking_started:'开始追踪', content_changed:'检测到文件变化', linked:'关联到作业', link_updated:'更新关联信息', unlinked:'移除关联', common_added:'设为常用文件', common_updated:'更新常用文件', common_removed:'取消常用文件', module_linked:'关联到周期任务', module_unlinked:'取消周期关联', relocated:'重新定位', renamed:'文件改名', rename_undone:'撤回改名' }
  const sizeLabel = (size: number | null) => size === null ? '' : size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`
  return <><div className="page-header"><div><h1>文件</h1><p>{usedFiles.length} 个文件 · {usedFiles.filter(({ file }) => isDriveReference(file) ? file.drive_unavailable : file.missing).length} 个链接待修复</p></div></div><div className="file-page-toolbar"><div className="search-field"><Search size={17} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索文件名或路径" /></div><select aria-label="按文件类型筛选" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}><option value="">全部类型</option><option value="pdf">PDF</option><option value="word">Word 文档</option><option value="image">图片</option><option value="other">其他</option></select><select aria-label="按科目筛选" value={courseFilter} onChange={e => setCourseFilter(e.target.value)}><option value="">全部科目</option>{snapshot.courses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}</select><label className="checkbox-label"><input type="checkbox" checked={missingOnly} onChange={e => setMissingOnly(e.target.checked)} />仅显示失效链接</label></div><div className="file-page-list">{visible.map(({ file, relations }) => { const events = relations.events; const expanded = historyFileId === file.id; return <div className="file-page-item" key={file.id}><div className="file-page-row"><div className={`file-page-icon ${(isDriveReference(file) ? file.drive_unavailable : file.missing) ? 'missing' : ''}`}><FileText size={21} /></div><div className="file-page-main"><strong>{attachmentName(file)}</strong><small className={`file-availability ${(isDriveReference(file) ? file.drive_unavailable : file.missing) ? 'is-unavailable' : ''}`}>{isDriveReference(file) ? (file.drive_unavailable ? 'Google Drive · 暂不可访问' : 'Google Drive · 链接') : isCloudReference(file.path) ? (file.cloud_available ? '云端内容可用' : '仅有文件信息') : file.missing ? '本机文件未找到' : '本机文件可用'}</small><FileRelations file={file} relations={relations} assignments={assignments} onOpenAssignment={onOpenAssignment} /></div><div className="file-page-actions"><FileTransferActions file={file} /><button className={`button button-quiet file-history-toggle ${events.length ? '' : 'is-empty'}`} onClick={() => setHistoryFileId(expanded ? '' : file.id)} aria-expanded={expanded} title="查看文件历史"><History size={16} />历史 {events.length}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>{file.missing && !isDriveReference(file) ? <button className="button button-quiet" onClick={() => onRelink(file)}><Link2 size={16} />{isCloudReference(file.path) ? "关联本机文件" : "重新定位"}</button> : <button className="button button-quiet file-open-button" disabled={!canOpenAttachment(file, service.isCloud)} onClick={() => { void service.openFile(file.id).catch(e => window.alert(`打开文件失败：${errorText(e)}`)) }} title={isDriveReference(file) ? "在 Google Drive 中打开" : canOpenAttachment(file, service.isCloud) ? "打开文件" : file.cloud_available ? "请先下载到本机" : "仅元数据，尚未上传内容"}><ExternalLink size={16} />{service.isCloud && !isDriveReference(file) ? '下载' : '打开'}</button>}</div></div>{expanded ? <div className="file-history-panel">{events.map(event => <div className="file-history-event" key={event.id}><span className={`file-history-dot event-${event.event_type}`} /><div><div className="file-history-heading"><strong>{eventLabels[event.event_type] || event.event_type}</strong><time>{fullDate(event.occurred_at)}</time></div>{event.assignment_title ? assignments.has(event.assignment_id) ? <button className="text-link" onClick={() => onOpenAssignment(event.assignment_id)}>{event.assignment_title}</button> : <span className="muted">曾关联：{event.assignment_title}</span> : null}{event.details ? <p>{event.details}</p> : null}<small title={fileName(event.path)}>{fileName(event.path)}{event.file_size !== null ? ` · ${sizeLabel(event.file_size)}` : ''}</small></div></div>)}{!events.length ? <div className="history-empty">尚无历史记录；下一次关联或文件操作会开始记录。</div> : null}</div> : null}</div> })}{!visible.length ? <div className="empty-list"><FolderOpen size={30} /><strong>{hasFilters ? '没有符合筛选条件的文件' : '没有找到关联文件'}</strong><span>{hasFilters ? '尝试调整搜索或筛选条件。' : '在作业详情中添加题目材料或解答。'}</span></div> : null}</div>{service.isDesktop ? <details className="history-section"><summary>可撤回的改名 <span>{snapshot.renames.length ? `${snapshot.renames.length} 条记录` : '暂无记录'}</span><ChevronDown size={15} /></summary><p>只有最近一次仍有效的改名可以撤回；文件被外部修改后会阻止撤回。</p>{snapshot.renames.map(event => <div className="history-row" key={event.id}><RotateCcw size={17} /><div><strong>{fileName(event.new_path)}</strong><small>原名：{fileName(event.old_path)} · {fullDate(event.changed_at)}</small></div>{event.undone_at ? <span className="muted">已撤回</span> : <button className="button button-quiet" onClick={() => onUndo(event.id)}>撤回</button>}</div>)}{!snapshot.renames.length ? <div className="history-empty">尚无改名记录</div> : null}</details> : null}</>
}

const phoneQuery = '(max-width: 780px), (max-width: 1024px) and (pointer: coarse)'
const subscribePhone = (notify: () => void) => { const query = window.matchMedia(phoneQuery); query.addEventListener('change', notify); return () => query.removeEventListener('change', notify) }
function MobileSettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const mobile = useSyncExternalStore(subscribePhone, () => window.matchMedia(phoneQuery).matches, () => false)
  if (!mobile) return children
  return <details className="mobile-setting-section"><summary><span>{title}<small>{description}</small></span><ChevronRight size={18} /></summary><div>{children}</div></details>
}

export function SettingsPage({ snapshot, onSaveSettings, onThemeChange, onEditCourse, onAddSemester, onDeleteSemester, onBackup, onRestore }: { snapshot: Snapshot; onSaveSettings: (value: Settings) => void; onThemeChange: (theme: Settings['theme']) => void; onEditCourse: (course: Course) => void; onAddSemester: () => void; onDeleteSemester: (semesterId: string) => void; onBackup: () => void; onRestore: () => void }) {
  const [settings, setSettings] = useState(snapshot.settings)
  const [modules, setModules] = useState<ModuleDescriptor[]>([])
  const [modulePath, setModulePath] = useState('')
  const [moduleBusy, setModuleBusy] = useState('')
  const [printingModuleId, setPrintingModuleId] = useState('')
  const [category, setCategory] = useState<'learning' | 'appearance' | 'connections' | 'extensions'>('learning')
  useEffect(() => setSettings(current => ({ ...current, naming_template: snapshot.settings.naming_template })), [snapshot.settings.naming_template])
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
  const categories = [
    { id: 'learning', title: '学习组织', description: '学期与课程' },
    { id: 'appearance', title: '外观', description: service.isDesktop ? '主题与文件命名' : '界面主题' },
    { id: 'connections', title: '连接与数据', description: service.isDesktop ? '同步、Drive 与备份' : '同步与 Drive' },
    { id: 'extensions', title: '扩展功能', description: '功能模块与设置' },
  ] as const
  return <><div className="page-header"><div><h1>设置</h1><p>管理学习组织、外观、连接与功能模块</p></div></div>
    <div className="workspace-settings">
      <nav className="settings-category-nav" aria-label="设置分类">{categories.map(item => <button key={item.id} type="button" className={category === item.id ? 'active' : ''} aria-current={category === item.id ? 'page' : undefined} onClick={() => setCategory(item.id)}><span><strong>{item.title}</strong><small>{item.description}</small></span><ChevronRight size={17} aria-hidden="true" /></button>)}</nav>
      <div className="settings-category-content">
        <div className="settings-column" hidden={category !== 'learning'}><section className="settings-card"><div className="settings-card-title"><div><h2>学期与课程目录</h2><p>文件仍在原位置；目录用于按课程浏览和搜索。</p></div><button className="button button-quiet" onClick={onAddSemester}><Plus size={16} />添加学期</button></div>{snapshot.semesters.map(semester => <div className="semester-settings" key={semester.id}><div className="semester-settings-heading"><div><strong>{semester.name}</strong><small>{semester.source_root || '未关联学期根目录'}</small></div><button className="button button-quiet mobile-add-course" onClick={() => onEditCourse({ id: '', semester_id: semester.id, name: '', code: '', folder_path: '' })}><Plus size={15} />课程</button><button className="icon-button danger-hover" onClick={() => onDeleteSemester(semester.id)} disabled={snapshot.semesters.length <= 1} title={snapshot.semesters.length <= 1 ? '至少保留一个学期' : `删除 ${semester.name}`}><Trash2 size={16} /></button></div>{snapshot.courses.filter(c => c.semester_id === semester.id).map(course => <button key={course.id} className="course-settings-row" onClick={() => onEditCourse(course)}><Folder size={17} /><span>{course.name}<small>{course.folder_path || '未关联文件夹'}</small></span><Pencil size={15} /></button>)}</div>)}</section></div>
        <div className="settings-column" hidden={category !== 'appearance'}><section className="settings-card"><div className="settings-card-title"><div><h2>外观</h2><p>选择应用的显示主题，修改后立即生效。</p></div></div><div className="form-grid"><label className="form-field">界面主题<select value={snapshot.settings.theme} onChange={e => onThemeChange(e.target.value as Settings['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>{service.isDesktop ? <label className="form-field span-2">命名模板<input value={settings.naming_template} onChange={e => update({ naming_template:e.target.value })} /></label> : null}</div>{service.isDesktop ? <p className="helper-text">可用字段：{'{course_code}'}、{'{material}'}、{'{scope}'}（s 节或 ch 章）；兼容 {'{sections}'}；也兼容 {'{semester}'}、{'{course}'}、{'{assignment}'}、{'{role}'}、{'{version}'}。原文件扩展名会保留。</p> : null}{service.isDesktop ? <button className="button button-primary" onClick={() => onSaveSettings({ ...settings, theme: snapshot.settings.theme })}>保存命名模板</button> : null}</section></div>
        <div className="settings-column" hidden={category !== 'connections'}><MobileSettingsSection title="个人多设备同步" description="连接设备、管理授权与身份恢复"><SyncSettings /></MobileSettingsSection><MobileSettingsSection title="Google Drive" description="管理 Google 账号与文件链接"><DriveSettings /></MobileSettingsSection>{service.isDesktop ? <section className="settings-card"><div className="settings-card-title"><div><h2>数据库备份</h2><p>备份作业、关联路径、文件历史、模块开关、常用文件、自定义字段和设置；不包含实际文件、提示词文件或 API 密钥。</p></div></div><div className="backup-buttons"><button className="button button-quiet" onClick={onBackup}><Upload size={16} />导出备份</button><button className="button button-quiet" onClick={onRestore}><RotateCcw size={16} />从备份恢复</button><button className="button button-quiet" onClick={() => { void service.compactDatabase().then(() => window.alert("数据库已压缩")).catch(e => window.alert(`压缩失败：${errorText(e)}`)) }}>压缩数据库</button></div></section> : null}</div>
        <div className="settings-column" hidden={category !== 'extensions'}>{appModules.map(module => { const descriptor = modules.find(item => item.id === module.id); const enabled = descriptor?.enabled ?? false; return <MobileSettingsSection key={module.id} title={module.descriptor.name} description={enabled ? "已开启 · 点击管理" : "未开启 · 点击设置"}><module.SettingsCard enabled={enabled} snapshot={snapshot} onToggle={next => { if (descriptor && moduleBusy !== module.id) void setEnabled(module.id,next) }} /></MobileSettingsSection> })}{service.isDesktop ? <section className="settings-card"><div className="settings-card-title"><div><h2>其他功能模块</h2><p>没有专属设置界面的模块在这里管理；关闭后主程序会拒绝调用。</p></div></div>{modules.filter(module => !appModules.some(item => item.id === module.id)).map(module => <div className="module-row" key={module.id}><div><strong>{module.name} · {module.builtin ? "内置" : "外部"}</strong><small>v{module.version} · {module.capabilities.join("、")}</small>{!module.builtin && module.capabilities.includes('file.print.configure') ? <button className="button button-quiet" disabled={!module.enabled || moduleBusy === module.id} onClick={() => setPrintingModuleId(module.id)}>打印设置</button> : null}</div><button className={`module-toggle ${module.enabled ? 'enabled' : ''}`} role="switch" aria-checked={module.enabled} disabled={moduleBusy === module.id} onClick={() => { void setEnabled(module.id,!module.enabled) }}><span />{module.enabled ? '已开启':'已关闭'}</button></div>)}{!modules.filter(module => !appModules.some(item => item.id === module.id)).length ? <div className="settings-empty">当前没有其他模块。</div> : null}<p className="helper-text">模块目录：{modulePath || "加载中…"}</p><div className="backup-buttons"><button className="button button-quiet" onClick={() => { void service.openModulesDirectory().catch(e => window.alert(errorText(e))) }}><FolderOpen size={16} />打开模块目录</button><button className="button button-quiet" onClick={() => { void service.listModules(appModules.map(module => module.descriptor)).then(items => { setModules(items); window.dispatchEvent(new CustomEvent('homeworkbook:module-state-changed')) }).catch(e => window.alert(errorText(e))) }}>刷新模块</button></div></section> : null}</div>
      </div>
    </div>{printingModule ? <PrintSettingsDialog key={printingModule.id} module={printingModule} onClose={() => setPrintingModuleId('')} /> : null}</>
}
