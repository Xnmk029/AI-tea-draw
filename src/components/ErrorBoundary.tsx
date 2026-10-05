import { Component, type ReactNode } from 'react'

/** 渲染层兜底：崩溃时给一张纸样式的错误卡，而不是整个舞台空白 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {}
  static getDerivedStateFromError(err: Error) {
    return { err }
  }
  render() {
    const { err } = this.state
    if (!err) return this.props.children
    return (
      <div className="error-card">
        <h2>这张纸破了</h2>
        <p className="muted">界面渲染出了点问题。刷新重进即可；对局页加 ?resume=1 能找回未完成的画布。</p>
        <pre>{String(err?.message ?? err)}</pre>
        <button className="gbtn primary" onClick={() => location.reload()}>
          刷新
        </button>
      </div>
    )
  }
}
