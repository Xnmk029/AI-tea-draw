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
  /** peer→host 发意图；host 调用无意义 */
  intent(msg: RoomMsg): void
  /** host→全体成员广播 */
  broadcast(msg: RoomMsg): void
  /** host→指定成员定向发 */
  to(peerId: string, msg: RoomMsg): void
  members(): string[]
  close(): void
}

export interface NetHooks {
  /** 收到 data 包：host 收到意图 / peer 收到广播；from=发送者 peerId */
  onPacket: (from: string, msg: RoomMsg) => void
  /** 房间成员名单变化（transport 层，peerId 列表） */
  onMembers?: (members: string[]) => void
  /** 传输层断开/故障（BRIDGE_CLOSED / HOST_LEFT / fault） */
  onClose?: (reason: string) => void
}

/** 建/进房并装配 NetLink；失败抛错由调用方兜底（回退单机） */
export async function connectNet(params: NetParams, hooks: NetHooks): Promise<NetLink> {
  const client = new NetClient(params.port, params.token)
  client.on('packet', (p: NetPacket) => hooks.onPacket(p.from, p.data as RoomMsg))
  client.on('members', (r) => hooks.onMembers?.((r as NetInfo).members ?? []))
  client.on('closed', (r) => hooks.onClose?.((r as { reason?: string }).reason ?? 'CLOSED'))
  client.on('fault', (r) => hooks.onClose?.(`FAULT:${JSON.stringify(r)}`))
  await client.connect()

  const info = params.room ? await client.joinRoom(params.room) : await client.createRoom()
  const role: NetLink['role'] = info.hostId === info.selfId ? 'host' : 'peer'

  const link: NetLink = {
    role,
    selfId: info.selfId,
    hostId: info.hostId ?? info.selfId,
    room: info.room ?? '',
    transport: info.transport,
    intent: (msg) => void client.send(link.hostId, msg).catch(() => {}),
    broadcast: (msg) => {
      for (const m of client.state?.members ?? []) {
        if (m !== link.selfId) void client.send(m, msg).catch(() => {})
      }
    },
    to: (peerId, msg) => void client.send(peerId, msg).catch(() => {}),
    members: () => client.state?.members ?? [],
    close: () => client.close(),
  }

  if (role === 'peer') link.intent({ t: 'hello', name: params.name ?? '茶客' })
  return link
}
