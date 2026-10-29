import { CalendarDays, X } from 'lucide-react'

/** Keep native picking and keyboard support without its intrinsic WebKit layout. */
export function DateTimeField({ label, value, onChange }: { label: string; value: string | null; onChange: (value: string | null) => void }) {
  const inputValue = value?.slice(0, 16) || ''
  return <div className="form-field"><label className="date-time-field"><span>{label} <small>可留空</small></span><span className={`date-time-control${inputValue ? '' : ' is-empty'}`}><span className="date-time-value" aria-hidden="true">{inputValue ? inputValue.replaceAll('-', '/').replace('T', ' ') : '选择日期和时间'}</span><CalendarDays size={18} aria-hidden="true" /><input type="datetime-local" aria-label={label} value={inputValue} onChange={event => onChange(event.target.value || null)} /></span></label>{inputValue ? <button type="button" className="date-time-clear" aria-label={`清除${label}`} onClick={() => onChange(null)}><X size={13} />清除</button> : null}</div>
}
