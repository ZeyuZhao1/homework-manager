import { useState } from 'react'
import { setCalendarEnabled, useCalendarEnabled } from './preferences'

export function CalendarSettingsCard() {
  const enabled = useCalendarEnabled()
  const [error, setError] = useState('')
  return <section className="settings-card">
    <div className="settings-card-title"><div><h2>待办日历</h2><p>按截止日期查看作业，在待办中切换清单与日历。</p></div></div>
    <div className="module-row"><div><strong>日历视图</strong><small>仅此设备 · 默认关闭</small></div><button type="button" className={`module-toggle ${enabled ? 'enabled' : ''}`} role="switch" aria-label="启用待办日历" aria-checked={enabled} onClick={() => { setError(''); try { setCalendarEnabled(!enabled) } catch (reason) { setError(reason instanceof Error ? reason.message : '无法保存视图偏好') } }}><span />{enabled ? '已开启' : '已关闭'}</button></div>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </section>
}
