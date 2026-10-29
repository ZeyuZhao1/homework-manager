import { useEffect, useState } from 'react'
import { webSync } from './web'

type Provider = { id: 'github' | 'google'; enabled: boolean; bound?: boolean }
const labels = { github: 'GitHub', google: 'Google' }
export function IdentityProviders({ mode }: { mode: 'login' | 'bind' }) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const load = async () => {
    setError('')
    try { setProviders((await webSync.request<{ providers: Provider[] }>('/recovery/providers')).providers) }
    catch { setError('无法读取登录配置') }
  }
  useEffect(() => {
    let live = true
    void webSync.request<{ providers: Provider[] }>('/recovery/providers').then(result => { if (live) setProviders(result.providers) }).catch(() => { if (live) setError('无法读取登录配置') })
    return () => { live = false }
  }, [])
  const unlink = async (provider: Provider) => {
    if (busy || !window.confirm(`解除 ${labels[provider.id]} 绑定？\n此账号将无法登录新设备，现有已授权设备仍可使用。`)) return
    setBusy(true); setError(''); setMessage('')
    try { await webSync.request(`/recovery/${provider.id}`, undefined, 'DELETE'); await load(); setMessage(`已解除 ${labels[provider.id]} 绑定`) }
    catch (e) { setError(e instanceof Error ? e.message : '解除绑定失败') }
    finally { setBusy(false) }
  }
  return <div className="identity-providers">
    {!providers.length && !error ? <p className="helper-text" role="status">正在读取登录配置…</p> : null}
    {providers.map(provider => <div className="identity-provider" key={provider.id}>
      {mode === 'bind' && provider.bound ? <><span className="identity-provider-label">{labels[provider.id]}<span className="sync-badge is-active">已绑定</span></span><button className="button button-quiet" disabled={busy} onClick={() => void unlink(provider)}>解除绑定</button></> : provider.enabled ? <a className="button button-quiet" href={`/api/recovery/${provider.id}/start?intent=${mode}`}>{mode === 'bind' ? '绑定' : '使用'} {labels[provider.id]}{mode === 'login' ? ' 登录' : ''}</a> : <button className="button button-quiet" disabled>{labels[provider.id]} · 未配置</button>}
    </div>)}
    {error ? <div className="sync-actions"><span className="inline-error" role="alert">{error}</span><button className="button button-quiet" disabled={busy} onClick={() => void load()}>重试</button></div> : null}
    {message ? <p className="helper-text" role="status">{message}</p> : null}
  </div>
}
