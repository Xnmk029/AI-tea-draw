import { useEffect, useRef, useState } from 'react'
import type { GuessRole, ModeId, RoomRules, Screen, Seat } from './core/types'
import type { SessionResult } from './game/gameTypes'
import { STAGE } from './core/geometry'
import { DEFAULT_RULES, INITIAL_SEATS } from './mock/room'
import { HomeScreen } from './screens/HomeScreen'
import { LobbyScreen } from './screens/LobbyScreen'
import { GameScreen } from './screens/GameScreen'
import { ResultScreen } from './screens/ResultScreen'
import { DemoNav } from './components/DemoNav'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Curtain, LayerRoots, Portal } from './ui/Shell'
import { netParams, savedNetRoom, useNetRoom } from './game/useNetRoom'
import { useAgentSession } from './agent/AgentSession'
import { usePetSandbox } from './agent/usePetSandbox'

// Demo 深链：?screen=game&mode=guess&role=guesser
const q = new URLSearchParams(location.search)
/** 联机会话（?net=…&token=…）：隐藏 Demo 占位 UI、启用真实建房/进房流 */
const netSession = q.has('net') && q.has('token')
const params = netParams()
const savedRoom = savedNetRoom(params)

export default function App() {
  const [screen, setScreen] = useState<Screen>((q.get('screen') as Screen) || 'home')
  const agentSession = useAgentSession()
  const pet = usePetSandbox(agentSession, screen === 'home')
  const [mode, setMode] = useState<ModeId>(savedRoom?.mode || (q.get('mode') as ModeId) || 'tea')
  const [rules, setRules] = useState<RoomRules>(savedRoom?.rules || DEFAULT_RULES)
  const [seats, setSeats] = useState<Seat[]>(INITIAL_SEATS)
  const [lastResult, setLastResult] = useState<SessionResult | null>(savedRoom?.result ?? null)
  const [guessRole, setGuessRole] = useState<GuessRole>((q.get('role') as GuessRole) || 'drawer')
  const [round, setRound] = useState(0)
  const [curtain, setCurtain] = useState<'idle' | 'in' | 'out'>('idle')
  const busy = useRef(false)
  const pendingScreen = useRef<Screen | null>(null)
  const screenRef = useRef(screen)
  screenRef.current = screen
  const [gameId, setGameId] = useState(savedRoom?.gameId ?? '')
  // 游戏式固定画幅：1920×1080 设计，整体等比缩放 + letterbox
  const [scale, setScale] = useState(() => Math.min(window.innerWidth / STAGE.w, window.innerHeight / STAGE.h))
  useEffect(() => {
    const on = () => setScale(Math.min(window.innerWidth / STAGE.w, window.innerHeight / STAGE.h))
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // 换屏统一走卷帘转场
  const go = (s: Screen) => {
    if (busy.current) { pendingScreen.current = s; return }
    if (s === screenRef.current) return
    busy.current = true
    setCurtain('in')
    window.setTimeout(() => {
      if (s === 'game') setRound((r) => r + 1)
      setScreen(s)
      const u = new URLSearchParams(location.search)
      u.set('screen', s)
      history.replaceState(null, '', `${location.pathname}?${u}`)
      setCurtain('out')
      window.setTimeout(() => {
        setCurtain('idle')
        busy.current = false
        const next = pendingScreen.current
        pendingScreen.current = null
        if (next && next !== screenRef.current) goRef.current(next)
      }, 520)
    }, 420)
  }
  const goRef = useRef(go)
  goRef.current = go
  const room = useNetRoom({
    params, screen, mode, rules, seats, onMode: setMode, onRules: setRules,
    onPhase: (phase, id, result) => {
      setGameId(id)
      if (result) setLastResult(result)
      goRef.current(phase)
    },
  })

  /** 联机会话：把房间码写进 URL 再进联机大厅等房（大厅接桥入座，开局自动进对局） */
  const joinNet = (code: string) => {
    const u = new URLSearchParams(location.search)
    u.set('room', code)
    u.set('screen', 'lobby')
    history.replaceState(null, '', `${location.pathname}?${u}`)
    room.enter(code)
    go('lobby')
  }
  const enter = () => { if (room.enabled) room.enter(); go('lobby') }
  const leave = () => { room.leave(); go('home') }
  const lobby = () => room.enabled ? room.isHost ? room.returnLobby() : leave() : go('lobby')
  const start = () => room.enabled ? room.start() : go('game')
  const viewSeats = room.enabled && room.seats.length ? room.seats : seats

  return (
    <div className="stage-outer">
      <div className="stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }} data-screen={screen}>
        <ErrorBoundary>
        {screen === 'home' && <HomeScreen mode={mode} onMode={setMode} onEnter={enter} onJoin={netSession ? joinNet : undefined} pet={pet} />}
        {screen === 'lobby' && (
          <LobbyScreen
            mode={mode}
            onMode={room.enabled ? room.changeMode : setMode}
            seats={viewSeats}
            onSeats={setSeats}
            rules={rules}
            onRules={room.enabled ? room.changeRules : setRules}
            onBack={room.enabled ? leave : () => go('home')}
            onStart={start}
            room={room}
          />
        )}
        {screen === 'game' && (!room.enabled || (room.link && room.ready)) && (
          <GameScreen
            key={room.enabled ? gameId : `${round}-${mode}-${guessRole}`}
            mode={mode}
            seats={viewSeats}
            rules={rules}
            guessRole={guessRole}
            netLink={room.link ?? undefined}
            onExit={lobby}
            onFinish={(r) => {
              if (room.enabled) room.finish(r)
              else { setLastResult(r); go('result') }
            }}
          />
        )}
        {screen === 'game' && room.enabled && (!room.link || !room.ready) && <div className="scr scr-lobby"><div className="l-panel"><aside className="sheet rules-sheet"><h2>连接茶桌</h2><p>{room.error ?? '正在等待房主同步房间…'}</p><button className="gbtn" onClick={room.retry}>重新连接</button><button className="gbtn ghost" onClick={leave}>返回</button></aside></div></div>}
        {screen === 'result' && <ResultScreen mode={mode} onMode={setMode} seats={viewSeats} result={lastResult} onLobby={lobby} onAgain={start} net={room.enabled} canStart={!room.enabled || room.isHost} />}
        </ErrorBoundary>
        <LayerRoots />
        <Portal layer="transition">
          <Curtain phase={curtain} />
        </Portal>
        {room.error && screen === 'game' && room.ready && <Portal layer="modal"><div className="overlay"><div className="modal"><h2>联机连接中断</h2><p>{room.error}</p><button className="gbtn" onClick={room.retry}>重新连接</button><button className="gbtn ghost" onClick={leave}>离开房间</button></div></div></Portal>}
        <Portal layer="debug">
          {/* Demo 跳转器只在 ?debug=1 显式开启；联机会话一律隐藏 */}
          {q.has('debug') && !netSession && (
            <DemoNav screen={screen} mode={mode} guessRole={guessRole} onScreen={go} onMode={setMode} onGuessRole={setGuessRole} />
          )}
        </Portal>
      </div>
    </div>
  )
}
