// 浏览器 ↔ teadraw 桥 的 WebSocket 客户端。
// 连不上就安静重试（玩家可能只是没跑 agent 进程）；断开后自动重连。
// 协议见 server/README.md。

export type LivePeerState = 'off' | 'connecting' | 'ready' | 'awake' | 'down'

export interface LivePeer {
  state: LivePeerState
  name?: string
  model?: string
}

export interface CallResult {
  /** 直接作为 MCP content 返回（例如 image 块） */
  content?: { type: string; [k: string]: unknown }[]
  /** 否则序列化成 text 块 */
  data?: unknown
  error?: { code: string; message: string }
}

interface ClientOptions {
  url: string
  join: () => Record<string, unknown>
  onPeer: (p: LivePeer) => void
  onCall: (name: string, args: Record<string, unknown>) => Promise<CallResult> | CallResult
  onDown?: () => void
}

export class McpClient {
  private ws: WebSocket | null = null
  private alive = true
  private retry = 0

  constructor(private o: ClientOptions) {
    this.open()
  }

  private open() {
    if (!this.alive) return
    this.o.onPeer({ state: 'connecting' })
    let ws: WebSocket
    try {
      ws = new WebSocket(this.o.url)
    } catch {
      this.schedule()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      ws.send(JSON.stringify({ t: 'join', role: 'game', ...this.o.join() }))
    }
    ws.onmessage = async (e) => {
      let msg: { t: string; [k: string]: any }
      try { msg = JSON.parse(String(e.data)) } catch { return }
      if (msg.t === 'joined') {
        if (msg.ok === false) {
          this.o.onPeer({ state: 'down' })
          ws.close()
          return
        }
        this.o.onPeer(msg.peer ? { state: msg.peer.state, name: msg.peer.name, model: msg.peer.model } : { state: 'ready' })
        return
      }
      if (msg.t === 'peer') {
        this.o.onPeer({ state: msg.state, name: msg.name, model: msg.model })
        return
      }
      if (msg.t === 'call') {
        let res: CallResult
        try {
          res = await this.o.onCall(msg.name, msg.args ?? {})
        } catch (err) {
          res = { error: { code: 'handler_error', message: String(err) } }
        }
        this.send({ t: 'result', id: msg.id, ok: !res.error, content: res.content, data: res.data, error: res.error })
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.o.onDown?.()
      this.o.onPeer({ state: 'off' })
      this.schedule()
    }
    ws.onerror = () => ws.close()
  }

  private schedule() {
    if (!this.alive) return
    this.retry++
    const wait = Math.min(15000, 3000 + this.retry * 1000)
    setTimeout(() => this.alive && this.open(), wait)
  }

  send(obj: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }

  /** 游戏事件 → 桥 → MCP notifications/message */
  event(ev: { type: string; [k: string]: unknown }) {
    this.send({ t: 'event', ev })
  }

  dispose() {
    this.alive = false
    this.ws?.close()
    this.ws = null
  }
}
