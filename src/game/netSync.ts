import { NetClient, type NetInfo, type NetPacket } from './netClient'

/* ============================================================
   netSync.ts — 联机房间协议层（星型拓扑，Host 权威）
   只负责传输胶水：建/进房、意图上行、广播下行。
   语义 handler（快照注水、意图校验、广播落账）在 useGame 内，
   因每个 handler 都深触内部状态。
   ============================================================ */

export interface NetParams {
  /** bridge WS 端口（teadraw-net.mjs net 起桥时打印） */
  port: number
  /** bridge token（同上，防本机其他进程劫持） */
  token: string
  /** 有 room = 加入既有房间（peer）；无 = 创建房间（host） */
  room?: string
  /** 进房报的名字（hello 意图） */
  name?: string
}

export type RoomMsg = Record<string, unknown> & { t: string }

export interface NetLink {
  role: 'host' | 'peer'
  selfId: string
  hostId: string
  room: string
  transport: string
  gameId: string
  seatRoster?: { peerId: string; seat: number; name: string; color: string }[]
  setGame(id: string): void
  subscribe(hooks: NetHooks, channel?: 'session' | 'game'): () => void
  /** peer→host 发意图；host 调用无意义 */
  intent(msg: RoomMsg): void
  /** host→全体成员广播 */
  broadcast(msg: RoomMsg): void
  /** host→指定成员定向发 */
  to(peerId: string, msg: RoomMsg): void
  members(): string[]
  close(): Promise<void>
  disconnect(): Promise<void>
}

export interface NetHooks {
  /** 收到 data 包：host 收到意图 / peer 收到广播；from=发送者 peerId */
  onPacket: (from: string, msg: RoomMsg) => void
  /** 房间成员名单变化（transport 层，peerId 列表） */
  onMembers?: (members: string[]) => void
  /** 传输层断开/故障（BRIDGE_CLOSED / HOST_LEFT / fault） */
  onClose?: (reason: string) => void
  onError?: (reason: string) => void
}

/** 建/进房并装配 NetLink；失败抛错由常驻会话显示错误和重试 */
export async function connectNet(params: NetParams, hooks: NetHooks): Promise<NetLink> {
  const client = new NetClient(params.port, params.token)
  const listeners = new Set<{ hooks: NetHooks; channel: 'session' | 'game' }>([{ hooks, channel: 'session' }])
  let buffered: NetPacket[] = []
  let bufferedSize = 0
  let link: NetLink | undefined
  let stopped = false
  let sending = Promise.resolve()
  const chunks = new Map<string, { total: number; parts: Map<number, string>; size: number; timer: number }>()
  const clearChunks = () => { chunks.forEach((entry) => window.clearTimeout(entry.timer)); chunks.clear() }
  const each = (fn: (h: NetHooks) => void) => listeners.forEach((l) => fn(l.hooks))
  const error = (e: unknown) => each((h) => h.onError?.(e instanceof Error ? e.message : String(e)))
  const gameplay = (m: RoomMsg) => m.t === 'session-over' || (!m.t.startsWith('lobby-') && !m.t.startsWith('session-'))
  client.on('packet', (p: NetPacket) => {
    if (stopped || !p.data || typeof p.data.t !== 'string') return
    if (link && (link.role === 'peer' ? p.from !== link.hostId : !link.members().includes(p.from))) return
    let msg = p.data as RoomMsg
    if (msg.t === 'session-chunk') {
      const { id, index, total, chunk } = msg
      if (typeof id !== 'string' || id.length > 80 || !Number.isInteger(index) || !Number.isInteger(total) || (total as number) < 1 || (total as number) > 400 || (index as number) < 0 || (index as number) >= (total as number) || typeof chunk !== 'string' || chunk.length > 48000) return
      const key = `${p.from}:${id}`
      if (!chunks.has(key)) {
        if (chunks.size >= 8) return
        chunks.set(key, { total: total as number, parts: new Map(), size: 0, timer: window.setTimeout(() => chunks.delete(key), 15000) })
      }
      const entry = chunks.get(key)!
      if (entry.total !== total || entry.parts.has(index as number)) return
      entry.parts.set(index as number, chunk)
      entry.size += chunk.length
      if ([...chunks.values()].reduce((size, item) => size + item.size, 0) > 16 * 1024 * 1024) { window.clearTimeout(entry.timer); chunks.delete(key); error(new Error('GAME_PACKET_TOO_LARGE')); return }
      if (entry.parts.size !== entry.total) return
      chunks.delete(key)
      window.clearTimeout(entry.timer)
      try { msg = JSON.parse(Array.from({ length: entry.total }, (_, i) => entry.parts.get(i)).join('')) } catch { return }
      if (!msg || typeof msg.t !== 'string' || msg.t === 'session-chunk') return
      p = { from: p.from, data: msg }
    }
    for (const l of listeners) if (l.channel === 'session') l.hooks.onPacket(p.from, msg)
    if (!gameplay(msg) || (link && msg.gameId !== link.gameId)) return
    const games = [...listeners].filter((l) => l.channel === 'game')
    if (!games.length) { buffered.push(p); bufferedSize += JSON.stringify(msg).length }
    else games.forEach((l) => l.hooks.onPacket(p.from, msg))
    if (buffered.length > 512 || bufferedSize > 16 * 1024 * 1024) { buffered = []; bufferedSize = 0; error(new Error('GAME_SYNC_REQUIRED')) }
  })
  client.on('members', (r) => each((h) => h.onMembers?.((r as NetInfo).members ?? [])))
  client.on('closed', (r) => {
    if (stopped) return
    stopped = true
    clearChunks()
    each((h) => h.onClose?.((r as { reason?: string }).reason ?? 'CLOSED'))
  })
  client.on('fault', (r) => error(`FAULT:${JSON.stringify(r)}`))

  let info: NetInfo
  try {
    await client.connect()
    const current = client.state
    info = current?.room && (!params.room || current.room === params.room)
      ? current
      : params.room ? await client.joinRoom(params.room) : await client.createRoom()
  } catch (e) {
    // 建/进房失败也要放掉 WS，否则桥的客户端槽位被占，刷新重连会 409
    stopped = true
    client.close()
    throw e
  }
  const role: NetLink['role'] = info.hostId === info.selfId ? 'host' : 'peer'

  const send = (recipients: string[], msg: RoomMsg) => {
    if (stopped || !recipients.length) return
    const payload = gameplay(msg) ? { ...msg, gameId: link!.gameId } : msg
    sending = sending.then(async () => {
      if (stopped) return
      const body = JSON.stringify(payload)
      if (body.length > 16 * 1024 * 1024) throw new Error('GAME_PACKET_TOO_LARGE')
      // 同次广播只编码、分片一次；收件人仍逐个有序发送，沿用客户端背压。
      let packets = [body]
      if (body.length > 48000) {
        const id = crypto.randomUUID()
        const total = Math.ceil(body.length / 48000)
        packets = Array.from({ length: total }, (_, index) => JSON.stringify({ t: 'session-chunk', id, index, total, chunk: body.slice(index * 48000, (index + 1) * 48000) }))
      }
      for (const to of recipients) {
        try {
          for (const packet of packets) {
            if (stopped) return
            await client.sendSerialized(to, packet)
          }
        } catch (e) { error(e) } // 某成员离房不阻断其余成员的落笔/结算。
      }
    }).catch(error)
  }
  link = {
    role,
    selfId: info.selfId,
    hostId: info.hostId ?? info.selfId,
    room: info.room ?? '',
    transport: info.transport,
    gameId: `${info.room}:initial`,
    setGame: (id) => {
      if (link!.gameId === id) return
      link!.gameId = id
      buffered = []
      bufferedSize = 0
      clearChunks()
    },
    subscribe: (h, channel = 'session') => {
      const listener = { hooks: h, channel }
      listeners.add(listener)
      h.onMembers?.(client.state?.members ?? [])
      if (channel === 'game') {
        const queued = buffered
        buffered = []
        bufferedSize = 0
        for (const p of queued) if (p.data.gameId === link!.gameId) h.onPacket(p.from, p.data as RoomMsg)
      }
      return () => { listeners.delete(listener) }
    },
    intent: (msg) => send([link!.hostId], msg),
    broadcast: (msg) => send((client.state?.members ?? []).filter((m) => m !== link!.selfId), msg),
    to: (to, msg) => send([to], msg),
    members: () => client.state?.members ?? [],
    close: () => {
      stopped = true
      listeners.clear()
      clearChunks()
      return client.leave().then(() => {}, () => {}).finally(() => client.close())
    },
    disconnect: () => { stopped = true; listeners.clear(); clearChunks(); return client.close() },
  }

  // 大厅与游戏订阅者各自握手；连接层不提前请求尚未挂载的完整游戏快照。
  return link
}
