export type Level = 1 | 2 | 3

/** Why a peer raised its level: same files, both on single-owner files, same working copy, or just the same repo. */
export type AlertKind = 'overlap' | 'hot' | 'checkout' | 'repo'

export type Alert = {
  sessionId: string
  level: Level
  kind: AlertKind
  /** The name the person sees for that session (its sidebar title), when it has one. */
  title: string
  /** The desktop app's id for that session, so the band can open it; empty outside the app. */
  hostId: string
  task: string
  branch: string
  overlap: string[]
}

export type CoordResult = { at: number; sent: number; failed: string[] }

declare module 'claude-code' {
  interface PluginState {
    huddle: {
      alerts: Alert[]
      snoozeUntil: number
      lastCoord: CoordResult | null
    }
  }
}
