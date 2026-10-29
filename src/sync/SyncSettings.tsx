import { useEffect, useState } from 'react'
import { service } from '../service'
import type { PairRequest, SyncDevice } from './protocol'
import { desktopSync } from './desktop'
import type { DesktopSyncStatus } from './desktop'
import { webSync } from './web'
import { IdentityProviders } from './IdentityProviders'

const entityLabels: Record<string, string> = {
  semester: '学期', course: '课程', assignment: '作业', file: '附件', link: '作业文件关联',
  common_file: '常用文件', module_file_link: '周期共享文件', setting: '外观与命名设置', module_state: '内置模块开关',
  provider: '服务商配置', ai_setting: 'AI 路由', recurring_series: '周期计划', recurring_occurrence: '周期节点',
  calendar: '教学周日历', history: '文件历史', import_course_map: '来源课程映射', import_link: '来源作业映射', import_ignored: '来源忽略记录',
}

export function SyncSettings() {
  const [status, setStatus] = useState<DesktopSyncStatus | null>(null)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('我的电脑')
  const [secret, setSecret] = useState('')
  const [bootstrap, setBootstrap] = useState(false)
  const [code, setCode] = useState('')
  const [pair, setPair] = useState<Pick<PairRequest, 'code' | 'expires_at'> | null>(null)
  const [devices, setDevices] = useState<SyncDevice[]>([])
  const [devicesLoaded, setDevicesLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const load = async () => {
    if (service.isDesktop) { const next = await desktopSync.status(); setStatus(next); setUrl(current => next.server_url || current); if (next.device_name) setName(next.device_name); if (!next.device_id) setDevices([]) }
    else if (service.isCloud) { setDevices((await webSync.request<{ devices: SyncDevice[] }>('/devices')).devices); setDevicesLoaded(true) }
  }
  const loadDevices = async () => { setDevices(service.isDesktop ? (await desktopSync.devices()).devices : (await webSync.request<{ devices: SyncDevice[] }>('/devices')).devices); setDevicesLoaded(true) }
  const run = async (work: () => Promise<unknown>, success = '操作完成') => { setBusy(true); setMessage(''); setFailed(false); try { await work(); await load(); setMessage(success) } catch (e) { setFailed(true); setMessage(e instanceof Error ? e.message : '操作失败') } finally { setBusy(false) } }
  const recovery = async (provider: 'github' | 'google') => { const target = new URL(url.trim()); if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) throw new Error('个人服务需要 HTTPS 地址'); target.pathname = `/api/recovery/${provider}/start`; target.search = '?intent=login'; target.hash = ''; await service.openUrl(target.toString()) }
  useEffect(() => { void Promise.resolve().then(load).catch(e => { setFailed(true); setMessage(e.message) }) }, [])
  useEffect(() => {
    if (!pair) return
    let live = true
    const timer = window.setInterval(() => { void desktopSync.poll().then(result => { if (!live) return; if (result.state === 'approved') { setPair(null); void load(); setMessage('配对成功；请确认后开启同步') } else if (result.state === 'expired') { setPair(null); setFailed(true); setMessage('配对已过期，请重新申请') } }).catch(e => { if (live) { setPair(null); setFailed(true); setMessage(e.message) } }) }, 3000)
    return () => { live = false; window.clearInterval(timer) }
  }, [pair])
  if (!service.isDesktop && !service.isCloud) return <section className="settings-card sync-settings"><div className="settings-card-title"><div><h2>个人多设备同步</h2><p>当前为浏览器演示。实际网页版通过同源个人服务连接；桌面同步默认关闭。</p></div></div></section>
  const pendingBaselines = service.isCloud ? webSync.pendingBaselines() : []
  const baselineEntries = Object.entries(status?.baseline_counts || {})
  const baselineTotal = baselineEntries.reduce((sum, [, count]) => sum + count, 0)
  return <section className="settings-card sync-settings" aria-label="个人多设备同步">
    <div className="settings-card-title"><div><h2>个人多设备同步</h2><p>{service.isDesktop ? '让课程、作业和周期计划在你的设备间保持同步。' : '当前浏览器通过已授权的个人云端会话在线使用。'}</p></div><span className={`sync-badge ${service.isCloud || status?.enabled ? 'is-active' : ''}`}>{service.isCloud ? '在线使用' : status?.enabled ? '已开启' : status?.connected ? '已暂停' : '未开启'}</span></div>
    {service.isDesktop && status ? <div className="sync-status-panel" role="status">
      <div className="sync-status-heading"><strong>{status.enabled ? '此设备正在同步' : status.connected ? '已配对，同步已暂停' : '连接你的个人服务'}</strong><span>{status.connected ? '已配置设备授权' : '尚未配对'}</span></div>
      <dl className="sync-status-stats"><div><dt>待发送更改</dt><dd>{status.pending}<small> 项</small></dd></div><div><dt>最近同步</dt><dd className="sync-status-date">{status.last_synced_at ? new Date(status.last_synced_at).toLocaleString() : '尚未同步'}</dd></div></dl>
    </div> : null}
    <p className="helper-text sync-privacy-note">本地路径、系统凭据和外部模块留在设备上。附件内容每次单独确认后上传；云端变更不会改动本地文件。</p>
    {pendingBaselines.length ? <p className="inline-error" role="status">正在等待 {pendingBaselines.map(device => device.name).join('、')} 完成首次导入，云端周期生成暂时暂停。请让该设备联网完成同步；若设备已经遗失，可刷新下方设备列表并撤销其授权后核对计划。</p> : null}
    {service.isDesktop ? <>
      {status?.error ? <p className="inline-error">{status.error}</p> : null}
      {!status?.device_id ? <div className="sync-section sync-connect-form">
        <div className="form-grid"><label className="form-field span-2">个人服务地址<input type="url" placeholder="https://your-private-service.example" value={url} onChange={e => setUrl(e.target.value)} autoComplete="off" spellCheck={false} /></label><label className="form-field span-2">设备名称<input value={name} onChange={e => setName(e.target.value)} /></label></div>
        <label className="checkbox-label"><input type="checkbox" checked={bootstrap} onChange={e => setBootstrap(e.target.checked)} />首次初始化个人服务</label>
        {bootstrap ? <label className="form-field">一次性初始化密钥<input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" /></label> : null}
        {pair ? <div className="sync-pair-panel" role="status"><span>在已授权设备的同步设置中输入</span><strong className="pair-code">{pair.code}</strong><span>等待批准 · {new Date(pair.expires_at).toLocaleTimeString()} 到期</span></div> : <div className="sync-actions"><button className="button button-primary" disabled={busy || !url || !name || (bootstrap && !secret)} onClick={() => void run(async () => { if (bootstrap) { await desktopSync.bootstrap(url.trim(), name.trim(), secret); setSecret('') } else setPair(await desktopSync.start(url.trim(), name.trim())) }, bootstrap ? '初始化成功；请确认后开启同步' : '等待其他设备批准')}>{busy ? '连接中…' : bootstrap ? '初始化' : '申请设备配对'}</button></div>}
      </div> : <div className="sync-section">
        {baselineEntries.length ? <details className="sync-baseline"><summary><span>首次同步内容<small>{baselineEntries.length} 类 · 共 {baselineTotal} 项</small></span><span className="sync-detail-hint">查看明细</span></summary><dl className="sync-baseline-grid">{baselineEntries.map(([key, count]) => <div key={key}><dt>{entityLabels[key] || '其他项目'}</dt><dd>{count}</dd></div>)}</dl><p className="helper-text">这里只包含记录和附件元数据，实际附件需另行确认上传。</p></details> : null}
        <div className="sync-actions"><button className="button button-primary" disabled={busy} onClick={() => void run(async () => { if (!window.confirm(status.enabled ? '暂停本设备同步？\n云管理周期仍由云端执行，本机不会接管生成；暂停期间修改会在恢复同步后生效。' : '开启同步并发送当前课程、作业、周期计划和附件元数据？\n本地路径和实际附件内容不会随此操作上传。')) throw new Error('已取消修改同步设置'); await desktopSync.setEnabled(!status.enabled) }, '同步设置已更新')}>{status.enabled ? '暂停同步' : '开启同步'}</button><button className="button button-quiet" disabled={busy || !status.enabled} onClick={() => void run(async () => { await desktopSync.now(); window.dispatchEvent(new Event('homeworkbook:sync-refreshed')) }, '已完成同步')}>立即同步</button><button className="button button-quiet" disabled={busy} onClick={() => { if (window.confirm('断开此设备的同步连接？本地记录会保留。\n云管理周期仍由云端执行，本机不会接管生成。')) void run(() => desktopSync.disconnect(), '已断开连接') }}>断开连接</button></div>
        <p className="helper-text">暂停或断开仅影响本设备；云管理周期继续由云端执行，本机不会接管生成。</p>
      </div>}
    </> : null}
    {service.isCloud || status?.device_id ? <>
      <div className="sync-section"><h3>批准新设备</h3><p className="helper-text">输入新设备上显示的配对码，确认授予访问权限。</p><div className="sync-pair-approval"><label className="form-field"><span className="sync-visually-hidden">新设备配对码</span><input aria-label="新设备配对码" placeholder="输入配对码" value={code} onChange={e => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} /></label><button className="button button-quiet" disabled={busy || !code.trim()} onClick={() => void run(async () => { if (service.isDesktop) await desktopSync.approve(code.trim()); else await webSync.request('/pair/approve', { code: code.trim() }); setCode('') }, '设备已授权')}>批准配对</button></div></div>
      <div className="sync-section"><div className="sync-section-heading"><h3>已授权设备</h3><button className="button button-quiet" disabled={busy} onClick={() => void run(loadDevices, '设备列表已刷新')}>刷新设备</button></div><p className="helper-text">{service.isDesktop ? '点击刷新才联网查询；同步关闭时，打开设置不会自动请求个人服务。' : '查看已授权设备；可随时撤销不再使用的设备。'}</p>
        {devices.length ? <div className="sync-device-list">{devices.map(device => <div className="sync-device" key={device.id}><span className="sync-device-icon" aria-hidden="true">{device.client_type === 'desktop' ? 'PC' : 'Web'}</span><div className="sync-device-info"><strong>{device.name}{device.current ? <span className="sync-badge">当前设备</span> : null}</strong><small>{device.client_type === 'desktop' ? '桌面应用' : '浏览器'} · 最近访问 {new Date(device.last_seen_at).toLocaleString()}</small></div><button className="button button-quiet" disabled={busy} onClick={() => { if (window.confirm(`撤销“${device.name}”的访问权限？`)) void run(async () => { if (service.isDesktop) await desktopSync.revoke(device.id); else { await webSync.request(`/devices/${encodeURIComponent(device.id)}`, undefined, 'DELETE'); if (device.current) window.location.reload() } }, '已撤销设备') }}>撤销</button></div>)}</div> : <div className="sync-empty"><strong>{devicesLoaded ? '暂无已授权设备' : '设备列表尚未加载'}</strong><span>{devicesLoaded ? '配对后，设备会显示在这里。' : '点击“刷新设备”查看当前授权。'}</span></div>}
      </div>
    </> : null}
    <div className="sync-section"><h3>{service.isDesktop ? '身份恢复' : '账号与登录'}</h3><p className="helper-text">{service.isDesktop ? '先在已授权网页绑定 GitHub 或 Google。恢复后可批准新设备；桌面授权不会自动登录网页。' : '绑定后可直接登录新设备。'}</p><div className="sync-actions sync-identity-actions">{service.isDesktop ? <><button className="button button-quiet" disabled={busy || !url} onClick={() => void run(() => recovery('github'), '已打开浏览器恢复入口')}>GitHub</button><button className="button button-quiet" disabled={busy || !url} onClick={() => void run(() => recovery('google'), '已打开浏览器恢复入口')}>Google</button></> : <><IdentityProviders mode="bind" /><button className="button button-quiet" disabled={busy} onClick={() => void run(async () => { await webSync.request('/logout', {}); window.location.reload() })}>退出此设备</button></>}</div></div>
    {message ? <p role={failed ? 'alert' : 'status'} className={failed ? 'inline-error' : 'sync-feedback'}>{message}</p> : null}
  </section>
}
