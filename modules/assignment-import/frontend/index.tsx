import { lazy, Suspense } from 'react'
import { Sparkles } from 'lucide-react'
import type { AppModule } from '../../../src/moduleTypes'
import './styles.css'
import manifest from '../module.json'

const AiDrawer = lazy(() => import('./Dialogs').then(module => ({ default: module.AiDrawer })))
const SettingsCard = lazy(() => import('./SettingsCard').then(module => ({ default: module.SettingsCard })))

export const module: AppModule = {
  id: manifest.id,
  Action: ({ onOpen }) => <button className="button button-quiet" onClick={onOpen}><Sparkles size={17} />AI 导入</button>,
  Overlay: ({ snapshot, onClose, onSettings, onSaved }) => <Suspense fallback={null}><AiDrawer courses={snapshot.courses} onClose={onClose} onSettings={onSettings} onSaved={onSaved} /></Suspense>,
  SettingsCard: ({ enabled, onToggle }) => <Suspense fallback={<section className="settings-card">正在加载模块设置…</section>}><SettingsCard enabled={enabled} onToggle={onToggle} /></Suspense>,
}
