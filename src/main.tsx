import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './App.css'
import App from './App.tsx'
import { TitleBar } from './TitleBar'
import { SyncRuntime } from './sync/SyncRuntime'
import { installMobileViewport } from './mobileViewport'

const disposeViewport = installMobileViewport()
if (import.meta.hot) import.meta.hot.dispose(disposeViewport)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TitleBar />
    <SyncRuntime />
    <App />
  </StrictMode>,
)
