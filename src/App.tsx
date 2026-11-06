import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, BookOpen, CalendarDays, ChevronDown, FileText, Folder, Inbox, ClipboardList, Repeat2, Moon, Plus, Search, Settings2, SlidersHorizontal, Sun, X } from 'lucide-react'
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

type View = 'overview' | 'course' | 'all' | 'files' | 'settings' | 'plans'
type Filter = 'open' | 'all' | 'doing' | 'done' | 'overdue' | 'submitted' | 'week'

function isUpcoming(value: string | null) {
  if (!value) return false
  const difference = new Date(value).getTime() - Date.now()
  return difference >= 0 && difference < 7 * 86400000
}

function App() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 780px), (max-width: 1024px) and (pointer: coarse)').matches)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [detailParentId, setDetailParentId] = useState('')
  const parentDetail = useRef<{ scrollTop: number; focus: HTMLElement | null }>({ scrollTop: 0, focus: null })
  const detailRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const moreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 780px), (max-width: 1024px) and (pointer: coarse)')
    const update = () => { setIsMobile(query.matches); setMobileDetailOpen(false); setMoreOpen(false); setDetailParentId('') }
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
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector('[role="menu"]')) return
      if (event.key === 'Escape') {
        if (document.querySelector('.modal-backdrop, .drawer-scrim')) return
        event.preventDefault(); detailRef.current?.querySelector<HTMLButtonElement>('.mobile-detail-bar button')?.click()
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
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); else main?.focus({ preventScroll: true })
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
  const [loadError, setLoadError] = useState('')
  const hasLoaded = useRef(false)
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
  const deferredSearch = useDeferredValue(search)
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
  const refreshRevision = useRef(0)
  const acceptedRefresh = useRef(0)

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current
    const data = await service.snapshot().catch(error => { if (!hasLoaded.current) setLoadError(errorText(error)); throw error })
    // Cloud snapshots already follow server cursors. For local reads, only a newer
    // successful response supersedes this one; a failed refresh must not discard it.
    if (!service.isCloud && revision < acceptedRefresh.current) return
    acceptedRefresh.current = Math.max(acceptedRefresh.current, revision)
    hasLoaded.current = true
    setLoadError('')
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
    const historyByFile = new Map<string, Snapshot['file_history'][number]>()
    for (const event of snapshot.file_history) if (!historyByFile.has(event.file_id)) historyByFile.set(event.file_id, event)
    const files = snapshot.files.filter(file => linkedIds.has(file.id) && !file.missing).map(file => {
      const history = historyByFile.get(file.id)
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

  const run = async (work: () => Promise<unknown>, success?: string, throwOnError = false) => {
    try { await work(); await refresh(); if (service.isDesktop) window.dispatchEvent(new Event('homeworkbook:local-data-changed')); if (success) setToast(success); return true } catch (error) { setToast(errorText(error)); if (throwOnError) throw error; return false }
  }
  const semesterCourses = useMemo(() => snapshot?.courses.filter(c => c.semester_id === semesterId) || [], [snapshot?.courses, semesterId])
  const courseById = useMemo(() => new Map(snapshot?.courses.map(course => [course.id, course])), [snapshot?.courses])
  const activeCourse = courseById.get(courseId)
  const scoped = useMemo(() => snapshot?.assignments.filter(a => {
    const course = courseById.get(a.course_id)
    return course?.semester_id === semesterId && (view !== 'course' || a.course_id === courseId)
  }) || [], [snapshot, semesterId, view, courseId, courseById])
  const filtered = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    return scoped.filter(item => {
    if (filter === 'open' && !isOpen(item)) return false
    if (filter === 'doing' && item.status !== 'doing') return false
    if (filter === 'done' && item.status !== 'done') return false
    if (filter === 'submitted' && item.status !== 'submitted') return false
    if (filter === 'overdue' && dueState(item) !== 'overdue') return false
    if (filter === 'week' && (!isOpen(item) || !isUpcoming(item.due_at))) return false
    return !needle || `${item.title} ${item.description} ${courseById.get(item.course_id)?.name || ''}`.toLowerCase().includes(needle)
    })
  }, [scoped, filter, deferredSearch, courseById])
  const openCount = scoped.filter(isOpen).length
  const fileCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const link of snapshot?.links || []) counts.set(link.assignment_id, (counts.get(link.assignment_id) || 0) + 1)
    return counts
  }, [snapshot?.links])
  const filesFor = useCallback((id: string) => fileCounts.get(id) || 0, [fileCounts])
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
    let alive = true
    void Promise.all(extensions.map(extension=>extension.loadGroups(snapshot))).then(values=>{ if (alive) setAssignmentGroups(values.flat()) }).catch(error=>{ if (alive) setToast(errorText(error)) })
    return () => { alive = false }
  },[snapshot,modulesReady,enabledAppModules])
  // Action lists show real assignments. Plans have their own management view.
  const visibleAssignments = useMemo(() => [...filtered].sort((a, b) => (a.due_at ? new Date(a.due_at).getTime() : Infinity) - (b.due_at ? new Date(b.due_at).getTime() : Infinity)), [filtered])
  const overviewGroups = useMemo(() => { const courseIds = new Set(semesterCourses.map(course => course.id)); return assignmentGroups.filter(group => courseIds.has(group.course_id)) }, [assignmentGroups, semesterCourses])
  const groupLabels = useMemo(() => Object.fromEntries(overviewGroups.flatMap(group => group.assignment_ids.map(id => [id, group.title]))), [overviewGroups])
  const selected = selectedId ? snapshot?.assignments.find(assignment => assignment.id === selectedId) : undefined
  const selectedGroup = assignmentGroups.find(group => group.id === selectedGroupId)
  const currentLinks = useMemo(() => selectedId ? snapshot?.links.filter(link => link.assignment_id === selectedId) || [] : [], [snapshot?.links, selectedId])
  const currentFileHistory = useMemo(() => {
    if (!selectedId || !snapshot) return []
    const ids = new Set(currentLinks.map(link => link.file_id))
    for (const event of snapshot.file_history) if (event.assignment_id === selectedId) ids.add(event.file_id)
    return snapshot.file_history.filter(event => ids.has(event.file_id))
  }, [snapshot, currentLinks, selectedId])
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
  const openCourse = (id: string) => { setDetailParentId(''); setMobileDetailOpen(false); setMoreOpen(false); setCourseId(id); setView('course'); setFilter('open'); setSearch(''); setSelectedId(''); setSelectedGroupId('') }
  const chooseView = (next: View) => { setDetailParentId(''); mainRef.current?.scrollTo({ top: 0, left: 0 }); setMobileDetailOpen(false); setMoreOpen(false); setView(next); setFilter('open'); setSearch(''); setSelectedId(''); setSelectedGroupId('') }
  const showAssignments = (nextFilter: OverviewFilter) => { chooseView('all'); setFilter(nextFilter); mainRef.current?.scrollTo({ top: 0 }) }
  const openOverviewAssignment = (id: string) => { setDetailParentId(''); setSelectedId(id); setSelectedGroupId(''); setMobileDetailOpen(true); setMoreOpen(false) }
  const openOverviewGroup = (id: string) => { setDetailParentId(''); setSelectedGroupId(id); setSelectedId(''); setMobileDetailOpen(true); setMoreOpen(false) }
  const openGroupAssignment = (id: string) => {
    parentDetail.current = { scrollTop: (detailRef.current?.querySelector('.mobile-detail-body') || mainRef.current)?.scrollTop || 0, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null }
    setDetailParentId(selectedGroupId); setSelectedGroupId(''); setSelectedId(id); setMobileDetailOpen(true)
    requestAnimationFrame(() => { const body = detailRef.current?.querySelector('.mobile-detail-body'); if (body) body.scrollTop = 0; detailRef.current?.focus({ preventScroll: true }) })
  }
  const closeDetail = () => {
    if (detailParentId && assignmentGroups.some(group => group.id === detailParentId)) {
      setSelectedGroupId(detailParentId); setSelectedId(''); setDetailParentId('')
      requestAnimationFrame(() => { const body = detailRef.current?.querySelector('.mobile-detail-body') || mainRef.current; if (body) body.scrollTop = parentDetail.current.scrollTop; if (parentDetail.current.focus?.isConnected) parentDetail.current.focus.focus({ preventScroll: true }); else detailRef.current?.focus({ preventScroll: true }) })
    } else { setMobileDetailOpen(false); setDetailParentId('') }
  }
  const saveAssignment = async (payload: Assignment) => { const okay = await run(() => service.saveAssignment(payload), payload.id ? '作业已更新' : '作业已创建', true); if (!okay) throw new Error('保存失败'); setEditor(current => current === editor ? null : current) }
  const setStatus = async (item: Assignment, status: Status) => { await run(() => service.saveAssignment({ ...item, status }), '状态已更新', true) }
  const deleteSelected = async () => { if (!selected || !window.confirm(`确定删除“${selected.title}”吗？关联记录会移除，磁盘文件不会删除。`)) return; const okay = await run(() => service.deleteAssignment(selected.id), '作业已删除'); if (!okay) return; setSelectedId(''); closeDetail() }
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

  const detailGroup = selectedGroup || assignmentGroups.find(group => group.id === detailParentId)
  const detailExtension = enabledAppModules.find(module => module.id === detailGroup?.module_id)?.assignmentList
  const GroupDetail = detailExtension?.Detail
  // Keep the source plan mounted while reading a child; returning then restores
  // its scroll position and original focused control without an async reload.
  const detailContent = snapshot && (detailGroup || selected) ? <>
    {detailGroup && GroupDetail ? <div hidden={!!detailParentId} inert={detailParentId ? true : undefined}><GroupDetail key={detailGroup.id} group={detailGroup} snapshot={snapshot} onRefresh={refresh} onEditAssignment={setEditor} onOpenAssignment={openGroupAssignment}/></div> : null}
    {!selectedGroup && selected ? <AssignmentDetail key={selected.id} printModules={printModules} item={selected} course={snapshot.courses.find(c => c.id === selected.course_id)} links={currentLinks} files={snapshot.files} fileHistory={currentFileHistory} onEdit={() => setEditor(selected)} onDelete={deleteSelected} onAddFile={role => setFileDrawer({ assignmentId: selected.id, role })} onEditLink={editing => setFileDrawer({ assignmentId: selected.id, editing })} onRename={setRenameLink} onStatus={status => setStatus(selected,status)} onRelink={relink} addon={enabledAppModules.map(module=>{const Addon=module.assignmentList?.AssignmentAddon;return Addon?<Addon key={module.id} assignment={selected} snapshot={snapshot}/>:null})}/> : null}
  </> : null

  if (!snapshot) return <div className="loading-screen"><BookOpen size={36} /><span>{loadError ? '暂时无法打开作业簿' : '正在打开作业簿…'}</span>{loadError ? <><p role="alert">{loadError}</p><button className="button button-quiet" onClick={() => { setToast(''); setLoadError(''); void refresh().catch(error => setToast(errorText(error))) }}>重新加载</button></> : null}</div>
  return <div className="app-shell" data-view={view} onDragStart={event => event.preventDefault()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    {isMobile ? <header className="mobile-topbar" inert={mobileDetailOpen || undefined}><a className="mobile-brand" href="#" onClick={event => { event.preventDefault(); chooseView('overview') }}><BookOpen size={22} strokeWidth={2} /><strong>作业簿</strong></a><div className="mobile-semester"><select value={semesterId} aria-label="选择学期" onChange={event => { setDetailParentId(''); setSemesterId(event.target.value); setCourseId(snapshot.courses.find(course => course.semester_id === event.target.value)?.id || ''); setSelectedId(''); setSelectedGroupId(''); setMoreOpen(false) }}>{snapshot.semesters.map(semester => <option key={semester.id} value={semester.id}>{semester.name}</option>)}</select><ChevronDown size={14} /></div></header> : null}
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><BookOpen size={26} strokeWidth={1.8} /></div><div><strong>作业簿</strong></div></div>
      <div className="semester-row"><CalendarDays className="semester-icon" size={16} aria-hidden="true" /><select value={semesterId} onChange={event => { setDetailParentId(''); setSemesterId(event.target.value); setCourseId(snapshot.courses.find(c => c.semester_id === event.target.value)?.id || ''); setSelectedId(''); setSelectedGroupId('') }} aria-label="选择学期">{snapshot.semesters.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select><ChevronDown className="semester-chevron" size={15} aria-hidden="true" /></div>
      <nav className="main-nav" aria-label="主导航"><button className={view === 'overview' ? 'active' : ''} onClick={() => chooseView('overview')}><ClipboardList size={19} />待办</button><button className={view === 'all' ? 'active' : ''} onClick={() => chooseView('all')}><FileText size={19} />作业</button>{enabledAppModules.some(module => module.assignmentList) ? <button className={view === 'plans' ? 'active' : ''} onClick={() => chooseView('plans')}><Repeat2 size={19} />周期计划</button> : null}<button className={view === 'files' ? 'active' : ''} onClick={() => chooseView('files')}><Folder size={19} />文件</button><button className={view === 'settings' ? 'active' : ''} onClick={() => chooseView('settings')}><Settings2 size={19} />设置</button></nav>
      <div className="sidebar-section-title"><span>我的课程</span><button className="icon-button tiny" onClick={() => setCourseEditor({ id: '', semester_id: semesterId, name: '', code: '', folder_path: '' })} title="添加课程"><Plus size={18} /></button></div><nav className="course-nav" aria-label="课程">{semesterCourses.map(course => <button key={course.id} className={view === 'course' && course.id === courseId ? 'active' : ''} onClick={() => openCourse(course.id)}><BookOpen className="course-nav-icon" size={18} strokeWidth={1.6} /><span>{course.name}</span></button>)}</nav>
      <div className="sidebar-bottom"><button onClick={() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')}>{snapshot.settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}{snapshot.settings.theme === 'system' ? '切换明暗' : snapshot.settings.theme === 'dark' ? '浅色模式' : '深色模式'}</button></div>
    </aside>
    <main ref={mainRef} tabIndex={-1} className="main-content" inert={isMobile && mobileDetailOpen || undefined}>

      {!snapshot.semesters.length ? <div className="settings-card"><p>先添加学期，再建立课程和作业。</p><button className="button button-primary" onClick={() => setSemesterEditor({ id: '', name: '', source_root: '' })}>添加学期</button></div> : !semesterCourses.length ? <div className="settings-card"><p>当前学期还没有课程。</p><button className="button button-primary" onClick={() => setCourseEditor({ id: '', semester_id: semesterId, name: '', code: '', folder_path: '' })}>添加课程</button></div> : null}
      {(view === 'course' || view === 'overview' || view === 'all' || view === 'plans') ? <>
        <div className="page-header">
          <div><h1>{view === 'course' ? activeCourse?.name || '课程' : view === 'overview' ? '待办' : view === 'plans' ? '周期计划' : '作业'}</h1>{view !== 'overview' ? <p>{view === 'plans' ? `${overviewGroups.length} 个计划` : `${scoped.length} 项作业 · ${openCount} 项未提交`}</p> : null}</div>
          <div className="header-actions desktop-actions">
            {syncModules.length ? <button className="button button-quiet" onClick={() => setImportInboxOpen(true)}><Inbox size={17}/>导入待审核{pendingImportCount ? ` (${pendingImportCount})` : ''}</button> : null}
            {enabledAppModules.map(module => <module.Action key={module.id} onOpen={() => setActiveModuleId(module.id)} />)}
            <button className="button button-primary" disabled={!semesterCourses.length} onClick={() => setEditor(blankAssignment(view === 'course' ? courseId : semesterCourses[0]?.id || ''))}><Plus size={18} />新建作业</button>
          </div>
          {isMobile ? <div className="mobile-header-actions"><div className="mobile-more" ref={moreRef}>
            <button className="mobile-create" aria-label="新增" aria-expanded={moreOpen} aria-controls="mobile-create-actions" onClick={() => setMoreOpen(open => !open)}><Plus size={23} /></button>
            {moreOpen ? <div className="mobile-more-menu" id="mobile-create-actions" onClick={() => setMoreOpen(false)}>
              <button className="button button-quiet" disabled={!semesterCourses.length} onClick={() => setEditor(blankAssignment(view === 'course' ? courseId : semesterCourses[0]?.id || ''))}><Plus size={17} />新建作业</button>
              {enabledAppModules.map(module => <module.Action key={module.id} onOpen={() => setActiveModuleId(module.id)} />)}
              {enabledAppModules.some(module => module.assignmentList) ? <button className="button button-quiet" onClick={() => chooseView('plans')}><Repeat2 size={17} />管理周期计划</button> : null}
              {syncModules.length ? <button className="button button-quiet" onClick={() => setImportInboxOpen(true)}><Inbox size={17} />导入待审核{pendingImportCount ? ` (${pendingImportCount})` : ''}</button> : null}
              {service.isCloud ? <button className="button button-quiet" onClick={() => void refresh().catch(error => setToast(errorText(error)))}>刷新数据</button> : null}
            </div> : null}
          </div></div> : null}
        </div>
        <div className="task-workspace">
          <div className="task-workspace-list">
            {view === 'overview' ? <Overview key={semesterId} assignments={scoped} groups={overviewGroups} courses={semesterCourses} onOpenAssignment={openOverviewAssignment} onOpenGroup={openOverviewGroup} onViewAll={showAssignments} selectedId={selectedId} /> : view === 'plans' ? <>
              <div className="workspace-section-heading"><h2>全部计划</h2><span>{overviewGroups.length} 个</span></div>
              {overviewGroups.length ? <AssignmentTable items={[]} courses={snapshot.courses} selectedId="" onSelect={openOverviewAssignment} filesFor={filesFor} groupRows={overviewGroups.flatMap(group => {
                const extension = enabledAppModules.find(module => module.id === group.module_id)?.assignmentList
                if (!extension) return []
                const Row = extension.Row
                return [{ id: group.id, sortAt: group.next_at, node: <Row group={group} selected={selectedGroupId === group.id} courseName={snapshot.courses.find(course => course.id === group.course_id)?.name || '课程'} fileCount={snapshot.module_file_links.filter(link => link.module_id === group.module_id && link.owner_id === group.id).length} onSelect={() => openOverviewGroup(group.id)} /> }]
              })} /> : <div className="empty-list"><Repeat2 size={28}/><strong>尚无周期计划</strong><span>使用新增入口安排每周或按序生成的作业。</span></div>}
            </> : <>
              <div className="section-heading assignment-toolbar">
                <select className="mobile-course-filter" aria-label="筛选课程" value={view === 'course' ? courseId : ''} onChange={event => event.target.value ? openCourse(event.target.value) : chooseView('all')}><option value="">全部课程</option>{semesterCourses.map(course => <option key={course.id} value={course.id}>{course.name}</option>)}</select>
                <div className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索作业" aria-label="搜索作业" /></div>
              </div>
              <div className="filter-tabs" aria-label="筛选作业状态">{(isMobile ? [['open','待处理'],['all','全部'],['submitted','已提交']] : [['open','未提交'],['all','全部'],['doing','进行中'],['done','待提交'],['overdue','已逾期'],['week','7 天内'],['submitted','已提交']]).map(([key,label]) => <button aria-pressed={filter === key} className={filter === key ? 'active' : ''} onClick={() => { setFilter(key as Filter); setSelectedId(''); setSelectedGroupId('') }} key={key}>{label}</button>)}
                {isMobile ? <label className={`mobile-filter-more${['doing', 'done', 'overdue', 'week'].includes(filter) ? ' is-filtered' : ''}`}><SlidersHorizontal size={19} />{filter === 'doing' ? <span>进行中</span> : filter === 'done' ? <span>待提交</span> : filter === 'overdue' ? <span>已逾期</span> : filter === 'week' ? <span>7 天内</span> : null}<select aria-label="筛选状态" value={filter} onChange={event => { setFilter(event.target.value as Filter); setSelectedId(''); setSelectedGroupId('') }}><option value="open">待处理</option><option value="all">全部</option><option value="doing">进行中</option><option value="done">待提交</option><option value="overdue">已逾期</option><option value="week">7 天内</option><option value="submitted">已提交</option></select></label> : null}
              </div>
              <div className="workspace-results" role="status" aria-busy={search !== deferredSearch}><span>{search !== deferredSearch ? '正在筛选…' : `${visibleAssignments.length} 项结果`}</span>{search || !['open', 'all'].includes(filter) ? <button onClick={() => { setSearch(''); setFilter('open') }}>清除筛选</button> : null}</div>
              <AssignmentTable items={visibleAssignments} courses={snapshot.courses} groupLabels={groupLabels} selectedId={isMobile && !mobileDetailOpen ? '' : selected?.id || ''} onSelect={openOverviewAssignment} filesFor={filesFor} />
            </>}
          </div>
          {!isMobile ? <aside className="task-workspace-detail" aria-label="当前选择的详情">{detailParentId ? <button className="workspace-back" onClick={closeDetail}><ArrowLeft size={16}/>返回周期计划</button> : null}{detailContent || <div className="workspace-detail-empty"><FileText size={28}/><p>选择{view === 'plans' ? '一个计划' : '一项作业'}查看详情</p></div>}</aside> : null}
        </div>
      </> : null}
      {view === 'files' ? <FilesPage snapshot={snapshot} onRelink={relink} onOpenAssignment={id => { const assignment = snapshot.assignments.find(a => a.id === id); if (assignment) { setCourseId(assignment.course_id); setSemesterId(snapshot.courses.find(course => course.id === assignment.course_id)?.semester_id || semesterId); setDetailParentId(''); setSelectedId(id); setView('course'); setFilter('all'); setSearch(''); setSelectedGroupId(''); setMobileDetailOpen(true); setMoreOpen(false) } }} onUndo={id => { void run(() => service.undoRename(id), '文件名已撤回') }} /> : null}
      {view === 'settings' ? <><SettingsPage snapshot={themePreview ? { ...snapshot, settings: { ...snapshot.settings, theme: themePreview } } : snapshot} onThemeChange={setTheme} onSaveSettings={payload => { void saveSettings(payload) }} onEditCourse={setCourseEditor} onAddSemester={() => setSemesterEditor({ id: '', name: '', source_root: '' })} onDeleteSemester={id => { void deleteSemester(id) }} onBackup={async () => { const path = await service.pickBackupSave(); if (path) void run(() => service.backup(path), '数据库备份已保存') }} onRestore={async () => { const path = await service.pickBackupOpen(); if (path && window.confirm('恢复备份会替换当前数据库记录。关联文件仍在原位置。确定继续吗？')) void run(() => service.restore(path), '数据库已恢复，请检查文件链接') }} /></> : null}
    </main>
    {isMobile ? <nav className="mobile-bottom-nav" aria-label="主导航" inert={mobileDetailOpen || undefined}>{([{ key: 'overview', label: '待办', Icon: ClipboardList }, { key: 'all', label: '作业', Icon: FileText }, { key: 'files', label: '文件', Icon: Folder }, { key: 'settings', label: '设置', Icon: Settings2 }] as const).map(({key, label, Icon}) => <button key={key} className={view === key || key === 'all' && (view === 'course' || view === 'plans') ? 'active' : ''} aria-current={view === key || key === 'all' && (view === 'course' || view === 'plans') ? 'page' : undefined} onClick={() => chooseView(key)}><Icon size={21} strokeWidth={1.8} /><span>{label}</span></button>)}</nav> : null}
    {isMobile && mobileDetailOpen ? <section className="mobile-detail-screen" ref={detailRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={selectedGroup ? '周期作业详情' : '作业详情'}><div className="mobile-detail-bar"><button onClick={closeDetail}><ArrowLeft size={21} />{detailParentId ? '周期计划' : '返回'}</button><span>{selectedGroup ? '周期作业' : '作业详情'}</span></div><div className="mobile-detail-body">{detailContent || <p>这项作业已不在当前列表中。请返回查看其他作业。</p>}</div></section> : null}
    {editor ? <AssignmentEditor initial={editor} courses={snapshot.courses} recentValues={snapshot.recent_values} onClose={() => setEditor(null)} onSave={saveAssignment} /> : null}
    {enabledAppModules.filter(module => module.id === activeModuleId).map(module => <module.Overlay key={module.id} snapshot={snapshot} onClose={() => setActiveModuleId(null)} onSettings={() => { setActiveModuleId(null); chooseView('settings') }} onSaved={async () => { await refresh(); setActiveModuleId(null); setToast(module.savedMessage) }} />)}
    {importInboxOpen && syncModules.length ? <ImportInbox modules={syncModules} snapshot={snapshot} onClose={() => setImportInboxOpen(false)} onSaved={refresh}/> : null}
    {fileDrawer ? <FileDrawer snapshot={snapshot} assignmentId={fileDrawer.assignmentId} editing={fileDrawer.editing} initialRole={fileDrawer.role} onClose={() => setFileDrawer(null)} onSaved={async () => { await refresh(); setFileDrawer(current => current === fileDrawer ? null : current); setToast('文件关联已保存') }} onDelete={async id => { const okay = await run(() => service.unlinkFile(id), '文件关联已移除', true); if (!okay) throw new Error('移除失败，请重试'); setFileDrawer(null) }} /> : null}
    {renameLink ? <RenameDialog link={renameLink} file={snapshot.files.find(f => f.id === renameLink.file_id)} onClose={() => setRenameLink(null)} onDone={async () => { await refresh(); setRenameLink(current => current === renameLink ? null : current); setToast('文件已原地重命名，可在文件页撤回') }} /> : null}
    {courseEditor ? <CourseEditor initial={courseEditor} semesters={snapshot.semesters} onClose={() => setCourseEditor(null)} onSave={async value => { const okay = await run(() => service.saveCourse(value), '课程已保存', true); if (!okay) throw new Error('课程保存失败，请重试'); setCourseEditor(null) }} /> : null}
    {semesterEditor ? <SemesterEditor initial={semesterEditor} onClose={() => setSemesterEditor(null)} onSave={async value => { const okay = await run(() => service.saveSemester(value), '学期已保存', true); if (!okay) throw new Error('学期保存失败，请重试'); setSemesterEditor(null) }} /> : null}
    {toast ? <div className="toast" role="status"><AlertCircle size={17} />{toast}<button onClick={() => setToast('')} aria-label="关闭提示"><X size={15} /></button></div> : null}
  </div>
}

export default function Application() { return <SyncGate><App /></SyncGate> }
