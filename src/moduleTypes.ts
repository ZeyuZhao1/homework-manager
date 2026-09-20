import type { ComponentType } from 'react'
import type { Snapshot } from './types'

export interface AppModule {
  id: string
  Action: ComponentType<{ onOpen: () => void }>
  Overlay: ComponentType<{ snapshot: Snapshot; onClose: () => void; onSettings: () => void; onSaved: () => Promise<void> }>
  SettingsCard: ComponentType<{ enabled: boolean; onToggle: (enabled: boolean) => void }>
}
