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

// Demo 深链：?screen=game&mode=guess&role=guesser
const q = new URLSearchParams(location.search)

export default function App() {
  const [screen, setScreen] = useState<Screen>((q.get('screen') as Screen) || 'home')
  const [mode, setMode] = useState<ModeId>((q.get('mode') as ModeId) || 'tea')
  const [rules, setRules] = useState<RoomRules>(DEFAULT_RULES)
  const [seats, setSeats] = useState<Seat[]>(INITIAL_SEATS)
  const [lastResult, setLastResult] = useState<SessionResult | null>(null)
  const [guessRole, setGuessRole] = useState<GuessRole>((q.get('role') as GuessRole) || 'drawer')
  const [round, setRound] = useState(0)
  const [curtain, setCurtain] = useState<'idle' | 'in' | 'out'>('idle')
  const busy = useRef(false)
  // 游戏式固定画幅：1920×1080 设计，整体等比缩放 + letterbox
  const [scale, setScale] = useState(() => Math.min(window.innerWidth / STAGE.w, window.innerHeight / STAGE.h))
  useEffect(() => {
    const on = () => setScale(Math.min(window.innerWidth / STAGE.w, window.innerHeight / STAGE.h))
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  // 换屏统一走卷帘转场
  const go = (s: Screen) => {
    if (busy.current) return
    busy.current = true
    setCurtain('in')
    window.setTimeout(() => {
      if (s === 'game') setRound((r) => r + 1)
      setScreen(s)
      setCurtain('out')
      window.setTimeout(() => {
        setCurtain('idle')
        busy.current = false
      }, 520)
    }, 420)
  }

  return (
    <div className="stage-outer">
      <div className="stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }} data-screen={screen}>
        <ErrorBoundary>
        {screen === 'home' && <HomeScreen mode={mode} onMode={setMode} onEnter={() => go('lobby')} />}
        {screen === 'lobby' && (
          <LobbyScreen
            mode={mode}
            onMode={setMode}
            seats={seats}
            onSeats={setSeats}
            rules={rules}
            onRules={setRules}
            onBack={() => go('home')}
            onStart={() => go('game')}
          />
        )}
        {screen === 'game' && (
          <GameScreen
            key={`${round}-${mode}-${guessRole}`}
            mode={mode}
            seats={seats}
            rules={rules}
            guessRole={guessRole}
            onExit={() => go('lobby')}
            onFinish={(r) => {
              setLastResult(r)
              go('result')
            }}
          />
        )}
        {screen === 'result' && <ResultScreen mode={mode} onMode={setMode} seats={seats} result={lastResult} onLobby={() => go('lobby')} onAgain={() => go('game')} />}
        </ErrorBoundary>
        <LayerRoots />
        <Portal layer="transition">
          <Curtain phase={curtain} />
        </Portal>
        <Portal layer="debug">
          <DemoNav screen={screen} mode={mode} guessRole={guessRole} onScreen={go} onMode={setMode} onGuessRole={setGuessRole} />
        </Portal>
      </div>
    </div>
  )
}
