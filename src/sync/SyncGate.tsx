import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import type { PairRequest, PairResult } from './protocol'
import { SessionRequired, webSync } from './web'
import { IdentityProviders } from './IdentityProviders'
import { authFeedback } from './authFeedback'

export function SyncGate({ children }: { children: ReactNode }) {
  const [feedback, setFeedback] = useState(() => isTauri() ? null : authFeedback(window.location.search))
  const [ready, setReady] = useState(isTauri())
  const [authorization, setAuthorization] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('我的浏览器')
  const [secret, setSecret] = useState('')
  const [bootstrap, setBootstrap] = useState(false)
  const [pair, setPair] = useState<PairRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const initialize = async () => { setError(''); try { await webSync.initialize(); setReady(true); setAuthorization(false) } catch (e) { if (e instanceof SessionRequired) setAuthorization(true); else setError(e instanceof Error ? e.message : '无法连接服务') } }
  useEffect(() => {
    if (isTauri()) return
    const address = new URL(window.location.href)
    if (['auth', 'auth_error', 'recovery'].some(key => address.searchParams.has(key))) {
      for (const key of ['auth', 'auth_error', 'recovery', 'provider']) address.searchParams.delete(key)
      window.history.replaceState(window.history.state, '', address.href)
    }
    void Promise.resolve().then(initialize)
    const expired = () => { setAuthorization(true); setReady(false) }
    window.addEventListener('homeworkbook:session-required', expired)
    return () => window.removeEventListener('homeworkbook:session-required', expired)
  }, [])
  useEffect(() => {
    if (!pair) return
    let alive = true
    const timer = window.setInterval(() => { void webSync.request<PairResult>('/pair/poll', { pair_id: pair.pair_id, poll_secret: pair.poll_secret }).then(result => {
      if (!alive) return
      if (result.state === 'approved') { setPair(null); void initialize() }
      if (result.state === 'expired') { setPair(null); setError('配对已过期，请重新申请') }
    }).catch(e => { if (alive) { setError(e.message); setPair(null) } }) }, 3000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [pair])
  const connect = async () => {
    setBusy(true); setError('')
    try {
      if (bootstrap) { await webSync.request('/bootstrap', { bootstrap_secret: secret, device_name: name, client_type: 'web' }); setSecret(''); await initialize() }
      else setPair(await webSync.request<PairRequest>('/pair/start', { device_name: name, client_type: 'web' }))
    } catch (e) { setError(e instanceof Error ? e.message : '授权失败') } finally { setBusy(false) }
  }
  const notice = feedback ? <div className={`sync-auth-notice ${feedback.failed ? 'is-error' : ''}`} role={feedback.failed ? 'alert' : 'status'}><span>{feedback.message}</span><button type="button" aria-label="关闭提示" onClick={() => setFeedback(null)}>×</button></div> : null
  if (ready && !authorization) return <>{notice}{children}</>
  return <main className="sync-gate"><section className="settings-card sync-gate-card">
    <header className="sync-gate-heading"><span className="sync-gate-mark" aria-hidden="true">簿</span><div><h1>作业簿</h1><p>连接你的个人学习空间</p></div></header>
    {notice}
    {authorization ? <>
      <div className="sync-connect-form"><label className="form-field">设备名称<input value={name} onChange={e => setName(e.target.value)} autoComplete="off" /></label><label className="checkbox-label"><input type="checkbox" checked={bootstrap} onChange={e => setBootstrap(e.target.checked)} />首次建立个人云端</label>
        {bootstrap ? <label className="form-field">一次性初始化密钥<input type="password" value={secret} onChange={e => setSecret(e.target.value)} autoComplete="off" /></label> : null}
        {pair ? <div className="sync-pair-panel" role="status"><span>在已授权设备的同步设置中输入</span><strong className="pair-code">{pair.code}</strong><span>等待授权 · {new Date(pair.expires_at).toLocaleTimeString()} 到期</span></div> : <button className="button button-primary" disabled={busy || !name.trim() || (bootstrap && !secret)} onClick={() => void connect()}>{busy ? '连接中…' : bootstrap ? '初始化并授权' : '申请设备配对'}</button>}
      </div>
      <div className="sync-section"><h2>账号登录</h2><p className="helper-text">使用已绑定的账号登录。</p><IdentityProviders mode="login" /></div>
    </> : <div className="sync-connect-form"><p className="helper-text" role="status">{error ? '连接暂时不可用，请重试。' : '正在连接个人服务…'}</p><button className="button button-quiet" onClick={() => void initialize()}>重新连接</button></div>}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </section></main>
}
