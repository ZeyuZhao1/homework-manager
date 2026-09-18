import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, BookOpen, CalendarDays, ChevronDown, Clock3, FileText, Folder, LayoutDashboard, Moon, Plus, Search, Settings2, Sparkles, Sun, X } from 'lucide-react'
import { service } from './service'
import { blankAssignment } from './types'
import type { Assignment, Course, FileAsset, FileLink, FileRole, ProviderInput, Semester, Settings, Snapshot, Status } from './types'
import { AssignmentDetail, AssignmentTable, dueState, errorText, isOpen } from './ui'
import { AiDrawer, CourseEditor, ProviderEditor, SemesterEditor } from './dialogs'
import { AssignmentEditor, FileDrawer, RenameDialog } from './optimizedDialogs'
import { FilesPage, SettingsPage } from './pages'
import './App.css'

type View = 'overview' | 'course' | 'all' | 'files' | 'settings'
type Filter = 'open' | 'all' | 'doing' | 'done' | 'overdue' | 'submitted'

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [view, setView] = useState<View>('overview')
  const [semesterId, setSemesterId] = useState('')
  const [courseId, setCourseId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [filter, setFilter] = useState<Filter>('open')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<Assignment | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [fileDrawer, setFileDrawer] = useState<{ assignmentId: string; editing?: FileLink; role?: FileRole } | null>(null)
  const [renameLink, setRenameLink] = useState<FileLink | null>(null)
  const [courseEditor, setCourseEditor] = useState<Course | null>(null)
  const [semesterEditor, setSemesterEditor] = useState<Semester | null>(null)
  const [providerEditor, setProviderEditor] = useState<ProviderInput | null>(null)
  const [toast, setToast] = useState('')

  const refresh = useCallback(async () => {
    const data = await service.snapshot()
    setSnapshot(data)
    setSemesterId(current => current && data.semesters.some(s => s.id === current) ? current : data.semesters[0]?.id || '')
    setCourseId(current => current && data.courses.some(c => c.id === current) ? current : data.courses[0]?.id || '')
  }, [])
  useEffect(() => { refresh().catch(error => setToast(errorText(error))) }, [refresh])
  useEffect(() => { if (snapshot) document.documentElement.dataset.theme = snapshot.settings.theme }, [snapshot])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(timer) }, [toast])

  const run = async (work: () => Promise<unknown>, success?: string) => {
    try { await work(); await refresh(); if (success) setToast(success); return true } catch (error) { setToast(errorText(error)); return false }
  }
  const semesterCourses = useMemo(() => snapshot?.courses.filter(c => c.semester_id === semesterId) || [], [snapshot?.courses, semesterId])
  const activeCourse = snapshot?.courses.find(c => c.id === courseId)
  const scoped = useMemo(() => snapshot?.assignments.filter(a => {
    const course = snapshot.courses.find(c => c.id === a.course_id)
    return course?.semester_id === semesterId && (view !== 'course' || a.course_id === courseId)
  }) || [], [snapshot, semesterId, view, courseId])
  const filtered = useMemo(() => scoped.filter(item => {
    if (view === 'overview' && !isOpen(item)) return false
    if (filter === 'open' && !isOpen(item)) return false
    if (filter === 'doing' && item.status !== 'doing') return false
    if (filter === 'done' && item.status !== 'done') return false
    if (filter === 'submitted' && item.status !== 'submitted') return false
    if (filter === 'overdue' && dueState(item) !== 'overdue') return false
    const needle = search.trim().toLowerCase()
    return !needle || `${item.title} ${item.description} ${snapshot?.courses.find(c => c.id === item.course_id)?.name}`.toLowerCase().includes(needle)
  }), [scoped, view, filter, search, snapshot?.courses])
  const selected = filtered.find(a => a.id === selectedId) || filtered[0]
  const openCount = scoped.filter(isOpen).length
  const doneCount = scoped.filter(a => a.status === 'done').length
  const weekCount = scoped.filter(a => isOpen(a) && ['today', 'soon'].includes(dueState(a))).length
  const overdueCount = scoped.filter(a => dueState(a) === 'overdue').length
  const filesFor = (id: string) => snapshot?.links.filter(l => l.assignment_id === id).length || 0
  const currentLinks = snapshot?.links.filter(l => l.assignment_id === selected?.id) || []
  const setTheme = (theme: Settings['theme']) => { if (snapshot) void run(() => service.saveSettings({ ...snapshot.settings, theme })) }
  const openCourse = (id: string) => { setCourseId(id); setView('course'); setFilter('open'); setSearch(''); setSelectedId('') }
  const chooseView = (next: View) => { setView(next); setFilter('open'); setSearch(''); setSelectedId('') }
  const saveAssignment = async (payload: Assignment) => { const okay = await run(() => service.saveAssignment(payload), payload.id ? '作业已更新' : '作业已创建'); if (!okay) throw new Error('保存失败'); setEditor(null) }
  const setStatus = (item: Assignment, status: Status) => { void run(() => service.saveAssignment({ ...item, status }), '状态已更新') }
  const deleteSelected = async () => { if (!selected || !window.confirm(`确定删除“${selected.title}”吗？关联记录会移除，磁盘文件不会删除。`)) return; await run(() => service.deleteAssignment(selected.id), '作业已删除'); setSelectedId('') }
  const relink = async (file: FileAsset) => { const paths = await service.pickFiles(); if (paths[0]) void run(() => service.relinkFile(file.id, paths[0]), '文件已重新定位') }

  if (!snapshot) return <div className="loading-screen"><BookOpen size={36} /><span>正在打开作业簿…</span>{toast ? <p>{toast}</p> : null}</div>
  return <div className="app-shell" onDragStart={event => event.preventDefault()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><BookOpen size={26} fill="currentColor" strokeWidth={1.6} /></div><div><strong>作业簿</strong><small>专注于你的学习生活</small></div></div>
      <div className="semester-row"><select value={semesterId} onChange={event => { setSemesterId(event.target.value); setCourseId(snapshot.courses.find(c => c.semester_id === event.target.value)?.id || ''); setSelectedId('') }} aria-label="选择学期">{snapshot.semesters.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select><ChevronDown size={15} /></div>
      <nav className="main-nav" aria-label="主导航"><button className={view === 'overview' ? 'active' : ''} onClick={() => chooseView('overview')}><LayoutDashboard size={19} />总览</button><button className={view === 'all' ? 'active' : ''} onClick={() => chooseView('all')}><FileText size={19} />全部作业</button><button className={view === 'files' ? 'active' : ''} onClick={() => chooseView('files')}><Folder size={19} />文件</button><button className={view === 'settings' ? 'active' : ''} onClick={() => chooseView('settings')}><Settings2 size={19} />设置</button></nav>
      <div className="sidebar-section-title"><span>我的课程</span><button className="icon-button tiny" onClick={() => setCourseEditor({ id: '', semester_id: semesterId, name: '', code: '', folder_path: '' })} title="添加课程"><Plus size={18} /></button></div><nav className="course-nav" aria-label="课程">{semesterCourses.map(course => <button key={course.id} className={view === 'course' && course.id === courseId ? 'active' : ''} onClick={() => openCourse(course.id)}><span className="course-monogram">{course.name === 'Calculus' ? '∑' : course.name === 'Physics' ? '◉' : course.name === 'Linear Algebra' ? '□' : '◇'}</span><span>{course.name}</span></button>)}</nav>
      <div className="sidebar-bottom"><button onClick={() => setTheme(snapshot.settings.theme === 'dark' ? 'light' : 'dark')}>{snapshot.settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}{snapshot.settings.theme === 'dark' ? '浅色模式' : '深色模式'}</button><span>数据仅保存在本机</span></div>
    </aside>
    <main className="main-content">{!service.isDesktop ? <div className="preview-banner">浏览器预览模式 · 桌面版使用本地 SQLite 和真实文件操作</div> : null}
      {(view === 'course' || view === 'overview' || view === 'all') ? <><div className="page-header"><div><h1>{view === 'course' ? activeCourse?.name || '课程' : view === 'overview' ? '总览' : '全部作业'}</h1><p>{view === 'course' ? `${snapshot.semesters.find(s => s.id === semesterId)?.name || ''} · ${scoped.length} 项作业 · ${openCount} 项未提交` : view === 'overview' ? '优先处理即将截止和待提交的作业' : `${snapshot.assignments.length} 项作业，按截止时间排列`}</p></div><div className="header-actions"><button className="button button-quiet" onClick={() => setAiOpen(true)}><Sparkles size={17} />AI 导入</button><button className="button button-primary" onClick={() => setEditor(blankAssignment(view === 'course' ? courseId : semesterCourses[0]?.id || ''))}><Plus size={19} />新建作业</button></div></div>
        <div className="metric-grid"><div className="metric-card"><FileText size={23} /><div><span>待完成</span><strong>{scoped.filter(a => a.status === 'todo' || a.status === 'doing').length}</strong></div></div><div className="metric-card"><Clock3 size={23} /><div><span>待提交</span><strong>{doneCount}</strong></div></div><div className="metric-card"><CalendarDays size={23} /><div><span>本周截止</span><strong>{weekCount}</strong></div></div>{view === 'overview' ? <div className="metric-card metric-alert"><AlertCircle size={23} /><div><span>已逾期</span><strong>{overdueCount}</strong></div></div> : null}</div>
        <div className="section-heading"><h2>{view === 'course' ? '课程作业' : view === 'overview' ? '需要关注' : '作业列表'}</h2><div className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索作业" aria-label="搜索作业" /></div></div><div className="filter-tabs">{([['open','未提交'],['all','全部'],['doing','进行中'],['done','待提交'],['overdue','已逾期'],['submitted','已提交']] as [Filter,string][]).map(([key,label]) => <button className={filter === key ? 'active' : ''} onClick={() => { setFilter(key); setSelectedId('') }} key={key}>{label}</button>)}</div>
        <AssignmentTable items={filtered} courses={snapshot.courses} selectedId={selected?.id || ''} onSelect={setSelectedId} filesFor={filesFor} />{selected && filtered.some(a => a.id === selected.id) ? <AssignmentDetail item={selected} course={snapshot.courses.find(c => c.id === selected.course_id)} links={currentLinks} files={snapshot.files} onEdit={() => setEditor(selected)} onDelete={deleteSelected} onAddFile={role => setFileDrawer({ assignmentId: selected.id, role })} onEditLink={editing => setFileDrawer({ assignmentId: selected.id, editing })} onRename={setRenameLink} onStatus={status => setStatus(selected,status)} onRelink={relink} /> : null}</> : null}
      {view === 'files' ? <FilesPage snapshot={snapshot} onRelink={relink} onOpenAssignment={id => { const assignment = snapshot.assignments.find(a => a.id === id); if (assignment) { setCourseId(assignment.course_id); setSelectedId(id); setView('course'); setFilter('all') } }} onUndo={id => { void run(() => service.undoRename(id), '文件名已撤回') }} /> : null}
      {view === 'settings' ? <SettingsPage snapshot={snapshot} onSaveSettings={payload => { void run(() => service.saveSettings(payload), '设置已保存') }} onAddProvider={() => setProviderEditor({ id: '', name: '', kind: 'bailian', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', has_key: false, api_key: '' })} onEditProvider={provider => setProviderEditor({ ...provider, api_key: '' })} onDeleteProvider={id => { void run(() => service.deleteProvider(id), '服务商已删除') }} onEditCourse={setCourseEditor} onAddSemester={() => setSemesterEditor({ id: '', name: '', source_root: '' })} onBackup={async () => { const path = await service.pickBackupSave(); if (path) void run(() => service.backup(path), '数据库备份已保存') }} onRestore={async () => { const path = await service.pickBackupOpen(); if (path && window.confirm('恢复备份会替换当前数据库记录。关联文件仍在原位置。确定继续吗？')) void run(() => service.restore(path), '数据库已恢复，请检查文件链接') }} /> : null}
    </main>
    {editor ? <AssignmentEditor initial={editor} courses={snapshot.courses} recentValues={snapshot.recent_values} onClose={() => setEditor(null)} onSave={saveAssignment} /> : null}
    {aiOpen ? <AiDrawer courses={snapshot.courses} onClose={() => setAiOpen(false)} onSettings={() => { setAiOpen(false); chooseView('settings') }} onSaved={async () => { await refresh(); setAiOpen(false); setToast('识别结果已创建为作业') }} /> : null}
    {fileDrawer ? <FileDrawer snapshot={snapshot} assignmentId={fileDrawer.assignmentId} editing={fileDrawer.editing} initialRole={fileDrawer.role} onClose={() => setFileDrawer(null)} onSaved={async () => { await refresh(); setFileDrawer(null); setToast('文件关联已保存') }} onDelete={async id => { await run(() => service.unlinkFile(id), '文件关联已移除'); setFileDrawer(null) }} /> : null}
    {renameLink ? <RenameDialog link={renameLink} file={snapshot.files.find(f => f.id === renameLink.file_id)} onClose={() => setRenameLink(null)} onDone={async () => { await refresh(); setRenameLink(null); setToast('文件已原地重命名，可在文件页撤回') }} /> : null}
    {courseEditor ? <CourseEditor initial={courseEditor} semesters={snapshot.semesters} onClose={() => setCourseEditor(null)} onSave={async value => { const okay = await run(() => service.saveCourse(value), '课程已保存'); if (okay) setCourseEditor(null) }} /> : null}
    {semesterEditor ? <SemesterEditor initial={semesterEditor} onClose={() => setSemesterEditor(null)} onSave={async value => { const okay = await run(() => service.saveSemester(value), '学期已保存'); if (okay) setSemesterEditor(null) }} /> : null}
    {providerEditor ? <ProviderEditor initial={providerEditor} onClose={() => setProviderEditor(null)} onSave={async value => { const okay = await run(() => service.saveProvider(value), '服务商已保存'); if (okay) setProviderEditor(null) }} /> : null}
    {toast ? <div className="toast" role="status"><AlertCircle size={17} />{toast}<button onClick={() => setToast('')} aria-label="关闭提示"><X size={15} /></button></div> : null}
  </div>
}

export default App
