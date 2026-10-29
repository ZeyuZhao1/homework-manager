import type { SyncStatus } from './protocol'

/** One in-flight round; disabled devices only read their local status. */
export function createSyncRunner(adapter: { status(): Promise<SyncStatus>; now(): Promise<SyncStatus> }, refreshed: () => void) {
  let running = false
  let stopped = false
  return {
    async tick() {
      if (running || stopped) return
      running = true
      try {
        const status = await adapter.status()
        if (stopped || !status.enabled || !status.connected) return
        await adapter.now()
        if (!stopped) refreshed()
      } catch {
        // The native service persists its last error for Settings. Avoid repeated toasts.
      } finally { running = false }
    },
    stop() { stopped = true },
  }
}
