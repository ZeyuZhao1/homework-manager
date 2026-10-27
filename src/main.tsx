import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './App.css'
import App from './App.tsx'
import { TitleBar } from './TitleBar'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TitleBar />
    <App />
  </StrictMode>,
)
