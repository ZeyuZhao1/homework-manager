import type { AppModule } from './moduleTypes'

const entries = import.meta.glob<{ module: AppModule }>('../modules/*/frontend/index.tsx', { eager: true })
export const appModules = Object.values(entries).map(entry => entry.module)
