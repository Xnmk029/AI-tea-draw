/* ============================================================
   netClient.ts — 联机桥 WS 客户端（adapters/browser/bridge-client.js 的 TS 移植）
   协议（对 server/net/bridge.cjs）：
     请求 {id, op, ...payload}  op ∈ create | join | leave | send{to,data}
     事件 {event, result}      event ∈ state | packet | members | closed | fault
   ============================================================ */

export interface NetInfo {
  selfId: string
  room: string | null
  hostId: string | null
  members: string[]
  transport: string
}

export interface NetPacket {
  from: string
  data: Record<string, unknown>
}

export type NetEventName = 'state' | 'packet' | 'members' | 'closed' | 'fault'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: number
}

export class NetClient {
  state: NetInfo | null = null
  private ws: WebSocket | null = null
  private connecting: Promise<this> | null = null
  private closing: Promise<void> | null = null
  private seq = 0
  private pending = new Map<number, Pending>()
  private handlers = new Map<string, ((r: unknown) => void)[]>()

  constructor(private port: number, private token: string) {}

  on(name: NetEventName, fn: (r: never) => void): this {
    const list = this.handlers.get(name) ?? []
    list.push(fn as (r: unknown) => void)
    this.handlers.set(name, list)
    return this
  }

  private emit(name: string, r: unknown) {
    for (const fn of this.handlers.get(name) ?? []) fn(r)
  }

  connect(): Promise<this> {
    if (this.connecting) return this.connecting
    this.connecting = new Promise<this>((resolve, reject) => {
      this.closing = null
      const ws = (this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/bridge?token=${this.token}`))
      const timer = window.setTimeout(() => { ws.close(); reject(new Error('BRIDGE_CONNECT_TIMEOUT')) }, 10000)
      ws.onopen = () => {}
      ws.onerror = () => { window.clearTimeout(timer); reject(new Error('BRIDGE_UNAVAILABLE')) }
      ws.onmessage = (ev) => {
        let msg
        try { msg = JSON.parse(ev.data as string) } catch { this.emit('fault', { code: 'INVALID_MESSAGE' }); return }
        if (msg.event) {
          if (msg.event === 'state' || msg.event === 'members') this.state = msg.result
          if (msg.event === 'state') { window.clearTimeout(timer); resolve(this) }
          if (msg.event === 'closed') this.state = this.state ? { ...this.state, room: null, hostId: null, members: [] } : null
          this.emit(msg.event, msg.result)
          return
        }
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        window.clearTimeout(p.timer)
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
      }
      ws.onclose = () => {
        window.clearTimeout(timer)
        this.connecting = null
        reject(new Error('BRIDGE_CLOSED'))
        for (const p of this.pending.values()) {
          window.clearTimeout(p.timer)
          p.reject(new Error('BRIDGE_CLOSED'))
        }
        this.pending.clear()
        this.emit('closed', { reason: 'BRIDGE_CLOSED' })
      }
    })
    return this.connecting
  }

  private async request<T = unknown>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    await this.connect()
    if (this.pending.size >= 128 || (this.ws && this.ws.bufferedAmount > 1572864)) throw new Error('BRIDGE_BACKPRESSURE')
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error('BRIDGE_REQUEST_TIMEOUT')) }, 10000)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        this.ws!.send(JSON.stringify({ id, op, ...payload }))
      } catch (e) {
        this.pending.delete(id)
        window.clearTimeout(timer)
        reject(e)
      }
    })
  }

  createRoom() { return this.request<NetInfo>('create').then((s) => (this.state = s)) }
  joinRoom(room: string) { return this.request<NetInfo>('join', { room }).then((s) => (this.state = s)) }
  send(to: string, data: Record<string, unknown>) { return this.request('send', { to, data }) }
  leave() { return this.request<NetInfo>('leave').then((s) => (this.state = s)) }

  close(): Promise<void> {
    if (this.closing) return this.closing
    const ws = this.ws
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    this.closing = new Promise<void>((resolve) => {
      ws.addEventListener('close', () => resolve(), { once: true })
      ws.close()
    })
    return this.closing
  }
}
