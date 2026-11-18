import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './App.css'
import App from './App.tsx'
import { TitleBar } from './TitleBar'
import { SyncRuntime } from './sync/SyncRuntime'
import { installMobileViewport } from './mobileViewport'
import './mobileCanvas.css'
import './iosPolish.css'
import './workspace.css'
import './glassLayers.css'
import './controlShapes.css'
import './floatingGlass.css'
import './macosChrome.css'
import { service } from './service'
import { installMacosContentControls } from './macosContentControls'

if (service.isMacDesktop) document.documentElement.dataset.macosDesktop = 'true'

const disposeContentControls = installMacosContentControls()
const disposeViewport = installMobileViewport()
if (import.meta.hot) import.meta.hot.dispose(() => { disposeViewport(); disposeContentControls() })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TitleBar />
    <SyncRuntime />
    <App />
  </StrictMode>,
)
