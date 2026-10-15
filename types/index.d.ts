export type Level = 1 | 2 | 3

/** Why a peer raised its level: same files, both on single-owner files, same working copy, or just the same repo. */
export type AlertKind = 'overlap' | 'hot' | 'checkout' | 'repo'

export type Alert = {
  sessionId: string
  level: Level
  kind: AlertKind
  /** The repo the alert is about: the strongest one the two sessions share. */
  repoKey: string
  repoName: string
  /** The name the person sees for that session (its sidebar title), when it has one. */
  title: string
  /** The desktop app's id for that session, so the band can open it; empty outside the app. */
  hostId: string
  task: string
  branch: string
  overlap: string[]
}

/** How a session is named to the person, and how the band opens it. */
export type Who = { title: string; task: string; hostId: string }

/** A member of the huddle edited a file the agreement gave to another member. */
export type OwnerConflict = { editor: Who; owner: Who; repoName: string; file: string }

/** What the band shows: nothing, the peers that are not in the huddle, or a calm line when everyone is. */
export type BandState =
  | { kind: 'none' }
  | { kind: 'alert'; alerts: Alert[]; hasHuddle: boolean }
  | { kind: 'huddle'; size: number; confirmed: number; leader: Who; leaderIsMe: boolean; conflicts: OwnerConflict[] }

export type CoordResult = { at: number; sent: number; failed: string[] }

declare module 'claude-code' {
  interface PluginState {
    huddle: {
      alerts: Alert[]
      band: BandState
      snoozeUntil: number
      lastCoord: CoordResult | null
    }
  }
}
