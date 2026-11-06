import { useEffect, useState } from 'react'

type StartupProps = { error?: string; onRetry: () => void }

export function StartupScreen(props: StartupProps) {
  return <StartupStage key={props.error ? `error:${props.error}` : 'loading'} {...props} />
}

function StartupStage({ error = '', onRetry }: StartupProps) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (error) return
    const timer = window.setTimeout(() => setSlow(true), 10000)
    return () => window.clearTimeout(timer)
  }, [error])
  return <main className="startup-screen" aria-label="打开作业簿">
    <div className="startup-content">
      <div className="startup-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7v14m0-14C9 4 5 4 2 5v15c3-1 7-1 10 1m0-14c3-3 7-3 10-2v15c-3-1-7-1-10 1" /></svg></div>
      <h1>作业簿</h1>
      <div className="startup-feedback">
        <p className="startup-status" role="status">{error ? '暂时无法打开' : '正在打开作业簿'}</p>
        {!error ? <div className="startup-progress" aria-hidden="true"><span /></div> : null}
      </div>
      {error ? <p className="startup-error" role="alert">{error}</p> : null}
      {slow && !error ? <p className="startup-hint" role="status">加载时间较长，可以重新打开。</p> : null}
      {error || slow ? <button className="startup-retry" type="button" onClick={error ? onRetry : () => window.location.reload()}>{error ? '重试' : '重新打开'}</button> : null}
    </div>
  </main>
}
