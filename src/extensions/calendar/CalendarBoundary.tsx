import { Component } from 'react'
import type { ReactNode } from 'react'

export class CalendarBoundary extends Component<{ children: ReactNode; onFallback: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (!this.state.failed) return this.props.children
    return <section className="calendar-unavailable" role="alert"><p>日历暂时无法加载，可以重新打开或切换清单。</p><div><button type="button" className="button button-quiet" onClick={this.props.onFallback}>使用清单</button><button type="button" className="button button-quiet" onClick={() => window.location.reload()}>重新打开</button></div></section>
  }
}
