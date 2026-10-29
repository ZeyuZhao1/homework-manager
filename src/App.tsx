import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, BookOpen, CalendarDays, ChevronDown, Clock3, FileText, Folder, Inbox, LayoutDashboard, Moon, MoreHorizontal, Plus, Search, Settings2, SlidersHorizontal, Sun, X } from 'lucide-react'
import { service } from './service'
import { blankAssignment } from './types'
import type { Assignment, Course, FileAsset, FileLink, FileRole, ModuleDescriptor, Semester, Settings, Snapshot, Status } from './types'
import { AssignmentDetail, AssignmentTable, dueState, errorText, isOpen } from './ui'
import { CourseEditor, SemesterEditor } from './dialogs'
import { appModules } from './moduleRegistry'
import type { AssignmentGroup } from './moduleTypes'
import { AssignmentEditor, FileDrawer, RenameDialog } from './optimizedDialogs'
import { FilesPage, SettingsPage } from './pages'
import { ImportInbox } from './ImportInbox'
import type { RemoteSnapshot } from './importSync'
import { Overview } from './overview'
import { applyTheme } from './theme'
import type { OverviewFilter } from './overview'
import './App.css'
import './mobile.css'
import { SyncGate } from './sync/SyncGate'

type View = 'overview' | 'course' | 'all' | 'files' | 'settings'
type Filter = 'open' | 'all' | 'doing' | 'done' | 'overdue' | 'submitted' | 'week'

function isUpcoming(value: string | null) {
  if (!value) return false
  const difference = new Date(value).getTime() - Date.now()
  return difference >= 0 && difference < 7 * 86400000
}

function App() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 780px)').matches)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const detailRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 780px)')
    const update = () => { setIsMobile(query.matches); setMobileDetailOpen(false); setMoreOpen(false) }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!isMobile || !mobileDetailOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const main = mainRef.current
    const scrollTop = main?.scrollTop || 0
    detailRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') {
        if (document.querySelector('.modal-backdrop, .drawer-scrim')) return
        event.preventDefault(); setMobileDetailOpen(false)
      }
      if (event.key !== 'Tab' || !detailRef.current?.contains(document.activeElement)) return
      const targets = Array.from(detailRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(element => element.getClientRects().length)
      const first = targets[0], last = targets[targets.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === detailRef.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('keydown', handleKey)
      if (main) main.scrollTop = scrollTop
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [isMobile, mobileDetailOpen])
  useEffect(() => {
    if (!moreOpen) return
    const dismiss = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMoreOpen(false); moreRef.current?.querySelector('button')?.focus() } }
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [moreOpen])
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [themePreview, setThemePreview] = useState<Settings['theme'] | null>(null)
  const themeWrites = useRef<Promise<void>>(Promise.resolve())
  const themeRevision = useRef(0)
  const [view, setView] = useState<View>('overview')
  const [semesterId, setSemesterId] = useState('')
  const [courseId, setCourseId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [selectedGroupId, setSelectedGroupId] = useState('')
  const [assignmentGroups, setAssignmentGroups] = useState<AssignmentGroup[]>([])
  const [filter, setFilter] = useState<Filter>('open')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<Assignment | null>(null)
  const [activeModuleId, setActiveModuleId] = useState<string | null>(null)
  const [importInboxOpen, setImportInboxOpen] = useState(false)
  const [pendingImportCount, setPendingImportCount] = useState(0)
  const [fileDrawer, setFileDrawer] = useState<{ assignmentId: string; editing?: FileLink; role?: FileRole } | null>(null)
  const [renameLink, setRenameLink] = useState<FileLink | null>(null)
  const [courseEditor, setCourseEditor] = useState<Course | null>(null)
  const [semesterEditor, setSemesterEditor] = useState<Semester | null>(null)
  const [toast, setToast] = useState('')
  const [moduleDescriptors, setModuleDescriptors] = useState<ModuleDescriptor[]>([])
  const [modulesReady, setModulesReady] = useState(false)
  const indexedNavigation = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    const data = await service.snapshot()
    setSnapshot(data)
    setSemesterId(current => current && data.semesters.some(s => s.id === current) ? current : data.semesters[0]?.id || '')
    setCourseId(current => current && data.courses.some(c => c.id === current) ? current : data.courses[0]?.id || '')
  }, [])
  useEffect(() => { refresh().catch(error => setToast(errorText(error))) }, [refresh])
  useEffect(() => { const reload = () => { void refresh().catch(error => setToast(errorText(error))) }; window.addEventListener('homeworkbook:sync-refreshed', reload); return () => window.removeEventListener('homeworkbook:sync-refreshed', reload) }, [refresh])
  useEffect(() => {
    if (!service.isCloud) return
    const update = () => { if (document.visibilityState === 'visible') void refresh().catch(error => setToast(errorText(error))) }
    const timer = window.setInterval(update, 30000)
    window.addEventListener('focus', update)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update) }
  }, [refresh])
  const refreshModules = useCallback(async () => { setModuleDescriptors(await service.listModules(appModules.map(module => module.descriptor))); setModulesReady(true) }, [])
  useEffect(() => {
    const update = () => { void refreshModules().catch(error => setToast(errorText(error))) }
    update(); window.addEventListener('homeworkbook:module-state-changed',update)
    return () => window.removeEventListener('homeworkbook:module-state-changed',update)
  }, [refreshModules])
  useEffect(() => { mainRef.current?.scrollTo({ top: 0, left: 0 }) }, [view, courseId])
  const currentTheme = themePreview ?? snapshot?.settings.theme
  useEffect(() => {
    if (!currentTheme) return
    applyTheme(currentTheme)
  }, [currentTheme])
  useEffect(() => {
    if (!snapshot || !modulesReady || !service.isDesktop) return
    const linkedIds = new Set(snapshot.links.map(link => link.file_id))
    const files = snapshot.files.filter(file => linkedIds.has(file.id) && !file.missing).map(file => {
      const history = snapshot.file_history.find(event => event.file_id === file.id)
      return { path:file.path, file_size:history?.file_size ?? null, modified_at_ms:history?.modified_at_ms ?? null }
    })
    if (!files.length) return
    for (const module of moduleDescriptors.filter(item => item.enabled && item.capabilities.includes('document.navigation.index'))) {
      const key = `${module.id}:${module.version}:${JSON.stringify(files)}`
      if (indexedNavigation.current.has(key)) continue
      indexedNavigation.current.add(key)
      void service.invokeModule(module.id,'document.navigation.index',{ files }).catch(error => {
        indexedNavigation.current.delete(key)
        setToast(`“${module.name}”建立目录索引失败：${errorText(error)}`)
      })
    }
  },[snapshot,moduleDescriptors,modulesReady])
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 5000); return () => window.clearTimeout(timer) }, [toast])

  const run = async (work: () => Promise<unknown>, success?: string) => {
    try { await work(); await refresh(); if (service.isDesktop) window.dispatchEvent(new Event('homeworkbook:local-data-changed')); if (success) setToast(success); return true } catch (error) { setToast(errorText(error)); return false }
  }
  const semesterCourses = useMemo(() => snapshot?.courses.filter(c => c.semester_id === semesterId) || [], [snapshot?.courses, semesterId])
  const activeCourse = snapshot?.courses.find(c => c.id === courseId)
  const scoped = useMemo(() => snapshot?.assignments.filter(a => {
    const course = snapshot.courses.find(c => c.id === a.course_id)
    return course?.semester_id === semesterId && (view !== 'course' || a.course_id === courseId)
  }) || [], [snapshot, semesterId, view, courseId])
  const filtered = useMemo(() => scoped.filter(item => {
    if (filter === 'open' && !isOpen(item)) return false
    if (filter === 'doing' && item.status !== 'doing') return false
    if (filter === 'done' && item.status !== 'done') return false
    if (filter === 'submitted' && item.status !== 'submitted') return false
    if (filter === 'overdue' && dueState(item) !== 'overdue') return false
    if (filter === 'week' && (!isOpen(item) || !isUpcoming(item.due_at))) return false
    const needle = search.trim().toLowerCase()
    return !needle || `${item.title} ${item.description} ${snapshot?.courses.find(c => c.id === item.course_id)?.name}`.toLowerCase().includes(needle)
  }), [scoped, filter, search, snapshot?.courses])
  const openCount = scoped.filter(isOpen).length
  const doneCount = scoped.filter(a => a.status === 'done').length
  const weekCount = scoped.filter(a => isOpen(a) && ['today', 'soon'].includes(dueState(a))).length
  const filesFor = (id: string) => snapshot?.links.filter(l => l.assignment_id === id).length || 0
  const enabledAppModules = useMemo(()=>modulesReady ? appModules.filter(module => moduleDescriptors.find(item => item.id === module.id)?.enabled !== false) : [],[modulesReady,moduleDescriptors])
  const printModules = useMemo(() => moduleDescriptors.filter(module => !module.builtin && module.enabled && module.capabilities.includes('file.print')), [moduleDescriptors])
  const syncModules = useMemo(() => moduleDescriptors.filter(module => module.enabled && module.capabilities.includes('assignment.sync.snapshot')), [moduleDescriptors])
  useEffect(() => {
    if (!service.isDesktop || !snapshot || !syncModules.length) return
    let alive = true
    const check = async () => {
      let count = 0
      for (const module of syncModules) {
        try {
          const source = await service.invokeModule<RemoteSnapshot>(module.id,'assignment.sync.snapshot',{})
          count += (await service.previewAssignmentImport(module.id,source)).items.length
        } catch { /* the inbox shows connection errors when opened */ }
      }
      if (alive) setPendingImportCount(count)
    }
    void check()
    const timer = window.setInterval(() => void check(), 300000)
    return () => {alive=false;window.clearInterval(timer)}
  },[snapshot,syncModules])
  useEffect(() => {
    if (!snapshot || !modulesReady) return
    const extensions=enabledAppModules.flatMap(module=>module.assignmentList?[module.assignmentList]:[])
    if(!extensions.length){setAssignmentGroups([]);setSelectedGroupId('');return}
    void Promise.all(extensions.map(extension=>extension.loadGroups(snapshot))).then(values=>setAssignmentGroups(values.flat())).catch(error=>setToast(errorText(error)))
  },[snapshot,modulesReady,enabledAppModules])
  const visibleGroups = useMemo(()=>assignmentGroups.filter(group=>{
    const course=snapshot?.courses.find(item=>item.id===group.course_id)
    if(course?.semester_id!==semesterId||(view==='course'&&group.course_id!==courseId))return false
    const needle=search.trim().toLowerCase();if(needle&&!`${group.search_text} ${course?.name||''}`.toLowerCase().includes(needle)&&!group.assignment_ids.some(id=>filtered.some(item=>item.id===id)))return false
    const childMatches=group.assignment_ids.some(id=>filtered.some(item=>item.id===id))
    if (filter === 'week') return childMatches || (group.status === 'active' && group.planned > 0 && isUpcoming(group.next_at))
    return childMatches||((filter==='open'||filter==='all')&&group.planned>0&&(view!=='overview'||group.status==='active'))
  }),[assignmentGroups,snapshot?.courses,semesterId,view,courseId,search,filtered,filter])
  const hiddenAssignmentIds = useMemo(()=>new Set(visibleGroups.flatMap(group=>group.assignment_ids)),[visibleGroups])
  const visibleAssignments = useMemo(()=>filtered.filter(item=>!hiddenAssignmentIds.has(item.id)),[filtered,hiddenAssignmentIds])
  const overviewGroups = assignmentGroups.filter(group => semesterCourses.some(course => course.id === group.course_id))
  const selected = (view === 'overview' || isMobile && mobileDetailOpen) && selectedId ? snapshot?.assignments.find(assignment => assignment.id === selectedId) : visibleAssignments.find(a => a.id === selectedId) || (view !== 'overview' && !selectedGroupId ? visibleAssignments[0] : undefined)
  const selectedGroup = (view === 'overview' || isMobile && mobileDetailOpen ? assignmentGroups : visibleGroups).find(group=>group.id===selectedGroupId)
  const currentLinks = snapshot?.links.filter(l => l.assignment_id === selected?.id) || []
  const assignmentFileIds = new Set([...(currentLinks.map(link => link.file_id)), ...(snapshot?.file_history.filter(event => event.assignment_id === selected?.id).map(event => event.file_id) || [])])
  const currentFileHistory = snapshot?.file_history.filter(event => assignmentFileIds.has(event.file_id)) || []
  const saveSettings = async (payload: Settings) => { const saved = await run(() => service.saveSettings(payload), '设置已保存'); if (saved) applyTheme(payload.theme) }
  const setTheme = (theme: Settings['theme']) => {
    if (!snapshot) return
    const revision = ++themeRevision.current
    setThemePreview(theme)
    applyTheme(theme)
    // Keep rapid selections ordered and avoid painting an older in-flight response.
    themeWrites.current = themeWrites.current.then(async () => {
      const saved = await run(() => service.saveSettings({ ...snapshot.settings, theme }), '主题已更新')
      if (revision !== themeRevision.current) return
      setThemePreview(null)
      if (!saved) applyTheme(snapshot.settings.theme)
    })
  }
  const openCourse = (id: string) => { setMobileDetailOpen(false); setMoreOpen(false); setCourseId(id); setView('course'); setFilter('open'); setSearch(''); setSelectedId(''); setSelectedGroupId('') }
  const chooseView = (next: View) => { mainRef.current?.scrollTo({ top: 0, left: 0 }); setMobileDetailOpen(false); setMoreOpen(false); setView(next); setFilter('open'); setSearch(''); setSelectedId(''); setSelectedGroupId('') }
  const showAssignments = (nextFilter: OverviewFilter) => { chooseView('all'); setFilter(nextFilter); mainRef.current?.scrollTo({ top: 0 }) }
  const openOverviewAssignment = (id: string) => { setSelectedId(id); setSelectedGroupId(''); setMobileDetailOpen(true); setMoreOpen(false) }
  const openOverviewGroup = (id: string) => { setSelectedGroupId(id); setSelectedId(''); setMobileDetailOpen(true); setMoreOpen(false) }
  const saveAssignment = async (payload: Assignment) => { const okay = await run(() => service.saveAssignment(payload), payload.id ? '作业已更新' : '作业已创建'); if (!okay) throw new Error('保存失败'); setEditor(current => current === editor ? null : current) }
  const setStatus = (item: Assignment, status: Status) => { void run(() => service.saveAssignment({ ...item, status }), '状态已更新') }
  const deleteSelected = async () => { if (!selected || !window.confirm(`确定删除“${selected.title}”吗？关联记录会移除，磁盘文件不会删除。`)) return; await run(() => service.deleteAssignment(selected.id), '作业已删除'); setSelectedId(''); setMobileDetailOpen(false) }
  const deleteSemester = async (id: string) => {
    const semester = snapshot?.semesters.find(item => item.id === id)
    if (!snapshot || !semester) return
    const courseIds = new Set(snapshot.courses.filter(item => item.semester_id === id).map(item => item.id))
    const assignmentCount = snapshot.assignments.filter(item => courseIds.has(item.course_id)).length
    if (!window.confirm(`确定删除“${semester.name}”吗？\n\n将同时删除 ${courseIds.size} 门课程、${assignmentCount} 项作业及其关联记录。磁盘中的学习文件不会删除。`)) return
    const okay = await run(() => service.deleteSemester(id), '学期已删除')
    if (okay) { setSelectedId(''); setView('overview') }
  }
  const relink = async (file: FileAsset) => { const paths = await service.pickFiles(); if (paths[0]) void run(() => service.relinkFile(file.id, paths[0]), '文件已重新定位') }

  const detailContent = snapshot ? (selectedGroup ? (()=>{const extension=enabledAppModules.find(module=>module.id===selectedGroup.module_id)?.assignmentList;if(!extension)return null;const Detail=extension.Detail;return <Detail group={selectedGroup} snapshot={snapshot} onRefresh={refresh} onEditAssignment={setEditor}/>})() : selected ? <AssignmentDetail printModules={printModules} item={selected} course={snapshot.courses.find(c => c.id === selected.course_id)} links={currentLinks} files={snapshot.files} fileHistory={currentFileHistory} onEdit={() => setEditor(selected)} onDelete={deleteSelected} onAddFile={role => setFileDrawer({ assignmentId: selected.id, role })} onEditLink={editing => setFileDrawer({ assignmentId: selected.id, editing })} onRename={setRenameLink} onStatus={status => setStatus(selected,status)} onRelink={relink} addon={enabledAppModules.map(module=>{const Addon=module.assignmentList?.AssignmentAddon;return Addon?<Addon key={module.id} assignment={selected} snapshot={snapshot}/>:null})}/> : null) : null

  if (!snapshot) return <div className="loading-screen"><BookOpen size={36} /><span>正在打开作业簿…</span>{toast ? <p>{toast}</p> : null}</div>
  return <div className="app-shell" data-view={view} onDragStart={event => event.preventDefault()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    {isMobile ? <header className="mobile-topbar" inert={mobileDetailOpen || undefined}><a className="mobile-brand" href="#" onClick={event => { event.preventDefault(); chooseView('overview') }}><BookOpen size={22} strokeWidth={2} /><strong>作业簿</strong></a><div className="mobile-semester"><select value={semesterId} aria-label="选择学期" onChange={event => { setSemesterId(event.target.value); setCourseId(snapshot.courses.find(course => course.semester_id === event.target.value)?.id || ''); setSelectedId(''); setSelectedGroupId(''); setMoreOpen(false) }}>{snapshot.semesters.map(semester => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</select><ChevronDown size={14} /></div></header> : null}
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><BookOpen size={26} fill="currentColor" strokeWidth={1.6} /></div><div><strong>作业簿</strong><small>专注于你的学习生活</small></div></div>
      <div className="semester-row"><CalendarDays className="semester-icon" size={16} aria-hidden="true" /><select value={semesterId} onChange={event => { setSemesterId(event.target.value); setCourseId(snapshot.courses.find(c => c.semester_id === event.target.value)?.id || ''); setSelectedId(''); setSelectedGroupId('') }} aria-label="选择学期">{snapshot.semesters.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select><ChevronDown className="semester-chevron" size={15} aria-hidden="true" /></div>
      <nav className="main-nav" aria-label="主导航"><button className={view === 'overview' ? 'active' : ''} onClick={() => chooseView('overview')}><LayoutDashboard size={19} />总览</button><button className={view === 'all' ? 'active' : ''} onClick={() => chooseView('all')}><FileText size={19} />全部作业</button><button className={view === 'files' ? 'active' : ''} onClick={() => chooseView('files')}><Folder size={19} />文件</button><button className={view === 'settings' ? 'active' : ''} onClick={() => chooseView('settings')}><Settings2 size={19} />设置</button></nav>
      <div className="sidebar-section-title"><span>我的课程</span><button className="icon-button tiny" onClick={() => setCourseEditor({ id: '', semester_id: semesterId, name: '', code: '', folder_path: '' })} title="添加课程"><Plus size={18} /></button></div><nav className="course-nav" aria-label="课程">{semesterCourses.map(course => <button key={course.id} className={view === 'course' && course.id === courseId ? 'active' : ''} onClick={() => openCourse(course.id)}><span className="course-monogram">{course.name === 'Calculus' ? '∑' : course.name === 'Physics' ? '◉' : course.name === 'Linear Algebra' ? '□' : '◇'}</span><span>{course.name}</span></button>)}</nav>
      <div className="sidebar-bottom"><button onClick={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>{snapshot.settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}{snapshot.settings.theme === 'system' ? '切换明暗' : snapshot.settings.theme === 'dark' ? '浅色模式' : '深色模式'}</button><span>{service.isCloud ? "个人云端 · 在线模式" : "本地优先 · 同步默认关闭"}</span></div>
    </aside>
    <main ref={mainRef} className="main-content" inert={isMobile && mobileDetailOpen || undefined}>

      {!snapshot.semesters.length ? <div className="settings-card"><p>先添加学期，再建立课程和作业。</p><button className="button button-primary" onClick={() => setSemesterEditor({ id: '', name: '', source_root: '' })}>添加学期</button></div> : !semesterCourses.length ? <div className="settings-card"><p>当前学期还没有课程。</p><button className="button button-primary" onClick={() => setCourseEditor({ id: '', semester_id: semesterId, name: '', code: '', folder_path: '' })}>添加课程</button></div> : null}
      {service.isCloud && !isMobile ? <div className="cloud-mode-note">在线同步 · 附件默认只同步元数据<button className="button button-quiet" onClick={() => void refresh().catch(e => setToast(errorText(e)))}>刷新</button></div> : null}
      {(view === 'course' || view === 'overview' || view === 'all') ? <><div className="page-header"><div><h1>{view === 'course' ? activeCourse?.name || '课程' : view === 'overview' ? '学习总览' : '全部作业'}</h1><p>{view === 'course' ? `${snapshot.semesters.find(s => s.id === semesterId)?.name || ''} · ${scoped.length} 项作业 · ${openCount} 项未提交` : view === 'overview' ? '优先处理即将截止和待提交的作业' : `${scoped.length} 项作业，按截止时间排列`}</p></div><div className="header-actions desktop-actions">{syncModules.length > 0 ? <button className="button button-quiet" onClick={() => setImportInboxOpen(true)}><Inbox size={17}/>导入待审核{pendingImportCount ? ` (${pendingImportCount})` : ''}</button> : null}{enabledAppModules.map(module => <module.Action key={module.id} onOpen={() => setActiveModuleId(module.id)} />)}<button className="button button-primary" onClick={() => setEditor(blankAssignment(view === 'course' ? courseId : semesterCourses[0]?.id || ''))}><Plus size={19} />新建作业</button></div>{isMobile ? <div className="mobile-header-actions"><div className="mobile-more" ref={moreRef}><button className="icon-button" aria-label="更多操作" aria-expanded={moreOpen} aria-controls="mobile-more-actions" onClick={() => setMoreOpen(open => !open)}><MoreHorizontal size={23} /></button>{moreOpen ? <div className="mobile-more-menu" id="mobile-more-actions" onClick={() => setMoreOpen(false)}>{enabledAppModules.map(module => <module.Action key={module.id} onOpen={() => setActiveModuleId(module.id)} />)}{syncModules.length ? <button className="button button-quiet" onClick={() => setImportInboxOpen(true)}><Inbox size={17} />导入待审核{pendingImportCount ? ` (${pendingImportCount})` : ''}</button> : null}{service.isCloud ? <button className="button button-quiet" onClick={() => void refresh().catch(error => setToast(errorText(error)))}>刷新数据</button> : null}<button className="button button-quiet" onClick={() => chooseView('settings')}><Settings2 size={17} />管理课程与设置</button></div> : null}</div><button className="mobile-create" aria-label="新建作业" disabled={!semesterCourses.length} onClick={() => setEditor(blankAssignment(view === 'course' ? courseId : semesterCourses[0]?.id || ''))}><Plus size={22} /></button></div> : null}</div>
        {view === 'overview' ? <Overview assignments={scoped} groups={overviewGroups} courses={semesterCourses} onOpenAssignment={openOverviewAssignment} onOpenGroup={openOverviewGroup} onViewAll={showAssignments} /> : <>
        <div className="metric-grid"><div className="metric-card"><FileText size={23} /><div><span>待完成</span><strong>{scoped.filter(a => a.status === 'todo' || a.status === 'doing').length}</strong></div></div><div className="metric-card"><Clock3 size={23} /><div><span>待提交</span><strong>{doneCount}</strong></div></div><div className="metric-card"><CalendarDays size={23} /><div><span>7 天内截止</span><strong>{weekCount}</strong></div></div></div>
        <div className="section-heading assignment-toolbar">{isMobile ? <select className="mobile-course-filter" aria-label="筛选课程" value={view === 'course' ? courseId : ''} onChange={event => event.target.value ? openCourse(event.target.value) : chooseView('all')}><option value="">全部课程</option>{semesterCourses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}</select> : null}<h2>{view === 'course' ? '课程作业' : '作业列表'}</h2><div className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索作业" aria-label="搜索作业" /></div></div><div className="filter-tabs">{(isMobile ? [['open','待处理'],['all','全部'],['submitted','已提交']] : [['open','未提交'],['all','全部'],['doing','进行中'],['done','待提交'],['overdue','已逾期'],['week','7 天内'],['submitted','已提交']]).map(([key,label]) => <button className={filter === key ? 'active' : ''} onClick={() => { setFilter(key as Filter); setSelectedId(''); setSelectedGroupId('') }} key={key}>{label}</button>)}{isMobile ? <label className={`mobile-filter-more${['doing', 'done', 'overdue', 'week'].includes(filter) ? ' is-filtered' : ''}`}><SlidersHorizontal size={19} />{filter === 'doing' ? <span>进行中</span> : filter === 'done' ? <span>待提交</span> : filter === 'overdue' ? <span>已逾期</span> : filter === 'week' ? <span>7 天内</span> : null}<select aria-label="筛选状态" value={filter} onChange={event => { setFilter(event.target.value as Filter); setSelectedId(''); setSelectedGroupId('') }}><option value="open">待处理</option><option value="all">全部</option><option value="doing">进行中</option><option value="done">待提交</option><option value="overdue">已逾期</option><option value="week">7 天内</option><option value="submitted">已提交</option></select></label> : null}</div>
        <AssignmentTable items={visibleAssignments} courses={snapshot.courses} selectedId={isMobile && !mobileDetailOpen ? '' : selected?.id || ''} onSelect={id=>{setSelectedId(id);setSelectedGroupId('');setMobileDetailOpen(true);setMoreOpen(false)}} filesFor={filesFor} groupRows={visibleGroups.flatMap(group=>{const extension=enabledAppModules.find(module=>module.id===group.module_id)?.assignmentList;if(!extension)return[];const Row=extension.Row;return[{id:group.id,sortAt:group.next_at,node:<Row group={group} selected={selectedGroupId===group.id} courseName={snapshot.courses.find(course=>course.id===group.course_id)?.name||'—'} fileCount={snapshot.module_file_links.filter(link=>link.module_id===group.module_id&&link.owner_id===group.id).length} onSelect={()=>{setSelectedGroupId(group.id);setSelectedId('');setMobileDetailOpen(true);setMoreOpen(false)}}/>}]})}/>
        </>}
        {!isMobile ? detailContent : null}</> : null}
      {view === 'files' ? <FilesPage snapshot={snapshot} onRelink={relink} onOpenAssignment={id => { const assignment = snapshot.assignments.find(a => a.id === id); if (assignment) { setCourseId(assignment.course_id); setSemesterId(snapshot.courses.find(course => course.id === assignment.course_id)?.semester_id || semesterId); setSelectedId(id); setView('course'); setFilter('all'); setSearch(''); setSelectedGroupId(''); setMobileDetailOpen(true); setMoreOpen(false) } }} onUndo={id => { void run(() => service.undoRename(id), '文件名已撤回') }} /> : null}
      {view === 'settings' ? <><SettingsPage snapshot={themePreview ? { ...snapshot, settings: { ...snapshot.settings, theme: themePreview } } : snapshot} onThemeChange={setTheme} onSaveSettings={payload => { void saveSettings(payload) }} onEditCourse={setCourseEditor} onAddSemester={() => setSemesterEditor({ id: '', name: '', source_root: '' })} onDeleteSemester={id => { void deleteSemester(id) }} onBackup={async () => { const path = await service.pickBackupSave(); if (path) void run(() => service.backup(path), '数据库备份已保存') }} onRestore={async () => { const path = await service.pickBackupOpen(); if (path && window.confirm('恢复备份会替换当前数据库记录。关联文件仍在原位置。确定继续吗？')) void run(() => service.restore(path), '数据库已恢复，请检查文件链接') }} /></> : null}
    </main>
    {isMobile ? <nav className="mobile-bottom-nav" aria-label="主导航" inert={mobileDetailOpen || undefined}>{([{ key: 'overview', label: '总览', Icon: LayoutDashboard }, { key: 'all', label: '作业', Icon: FileText }, { key: 'files', label: '文件', Icon: Folder }, { key: 'settings', label: '设置', Icon: Settings2 }] as const).map(({key, label, Icon}) => <button key={key} className={view === key || key === 'all' && view === 'course' ? 'active' : ''} aria-current={view === key || key === 'all' && view === 'course' ? 'page' : undefined} onClick={() => chooseView(key)}><Icon size={21} strokeWidth={1.8} /><span>{label}</span></button>)}</nav> : null}
    {isMobile && mobileDetailOpen ? <section className="mobile-detail-screen" ref={detailRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={selectedGroup ? '周期作业详情' : '作业详情'}><div className="mobile-detail-bar"><button onClick={() => setMobileDetailOpen(false)}><ArrowLeft size={21} />返回</button><span>{selectedGroup ? '周期作业' : '作业详情'}</span></div><div className="mobile-detail-body">{detailContent || <p>这项作业已不在当前列表中。请返回查看其他作业。</p>}</div></section> : null}
    {editor ? <AssignmentEditor initial={editor} courses={snapshot.courses} recentValues={snapshot.recent_values} onClose={() => setEditor(null)} onSave={saveAssignment} /> : null}
    {enabledAppModules.filter(module => module.id === activeModuleId).map(module => <module.Overlay key={module.id} snapshot={snapshot} onClose={() => setActiveModuleId(null)} onSettings={() => { setActiveModuleId(null); chooseView('settings') }} onSaved={async () => { await refresh(); setActiveModuleId(null); setToast(module.savedMessage) }} />)}
    {importInboxOpen && syncModules.length ? <ImportInbox modules={syncModules} snapshot={snapshot} onClose={() => setImportInboxOpen(false)} onSaved={refresh}/> : null}
    {fileDrawer ? <FileDrawer snapshot={snapshot} assignmentId={fileDrawer.assignmentId} editing={fileDrawer.editing} initialRole={fileDrawer.role} onClose={() => setFileDrawer(null)} onSaved={async () => { await refresh(); setFileDrawer(current => current === fileDrawer ? null : current); setToast('文件关联已保存') }} onDelete={async id => { await run(() => service.unlinkFile(id), '文件关联已移除'); setFileDrawer(null) }} /> : null}
    {renameLink ? <RenameDialog link={renameLink} file={snapshot.files.find(f => f.id === renameLink.file_id)} onClose={() => setRenameLink(null)} onDone={async () => { await refresh(); setRenameLink(current => current === renameLink ? null : current); setToast('文件已原地重命名，可在文件页撤回') }} /> : null}
    {courseEditor ? <CourseEditor initial={courseEditor} semesters={snapshot.semesters} onClose={() => setCourseEditor(null)} onSave={async value => { const okay = await run(() => service.saveCourse(value), '课程已保存'); if (okay) setCourseEditor(null) }} /> : null}
    {semesterEditor ? <SemesterEditor initial={semesterEditor} onClose={() => setSemesterEditor(null)} onSave={async value => { const okay = await run(() => service.saveSemester(value), '学期已保存'); if (okay) setSemesterEditor(null) }} /> : null}
    {toast ? <div className="toast" role="status"><AlertCircle size={17} />{toast}<button onClick={() => setToast('')} aria-label="关闭提示"><X size={15} /></button></div> : null}
  </div>
}

export default function Application() { return <SyncGate><App /></SyncGate> }
