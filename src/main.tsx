import { createRoot } from 'react-dom/client'
import App from './App'
import { AgentSessionProvider } from './agent/AgentSession'
import './styles/app.css'
import './ui/ui.css'
import './ui/fonts.css'
import './ui/assets.css'
import './ui/brush.css'

createRoot(document.getElementById('root')!).render(<AgentSessionProvider><App /></AgentSessionProvider>)
