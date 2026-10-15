import type { Alert, AlertKind, Level } from '../types'
import type { Words } from './i18n'

// One file per live session under ~/.claude/huddle/sessions/<sessionId>.json.
export type Presence = {
  v: 1
  sessionId: string
  cwd: string
  toplevel: string
  repoKey: string
  repoName: string
  branch: string
  task: string
  title?: string
  hostId?: string
  files: Record<string, number>
  startedAt: number
  lastSeen: number
  ended?: boolean
}

export const LIVE_MS = 60_000
export const FILE_WINDOW_MS = 4 * 60 * 60_000

// Files only one session should touch at a time (single-owner).
const HOT = [
  /(^|\/)package\.json$/,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/,
  /(^|\/)migrations?\//,
  /(^|\/)(schema\.prisma|drizzle\.config\.\w+)$/,
  /(^|\/)(schema|db\/schema)\.\w+$/,
  /(^|\/)generated\//,
]

export const isHot = (path: string) => HOT.some(re => re.test(path))

// git remote spellings collapse to one key: git@github.com:o/r.git == https://github.com/o/r
export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(':', '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase()
}

const recent = (files: Record<string, number>, now: number) =>
  Object.keys(files).filter(f => now - (files[f] ?? 0) < FILE_WINDOW_MS)

export function isLive(p: Presence, now: number): boolean {
  return !p.ended && now - p.lastSeen < LIVE_MS
}

export function assess(me: Presence, peer: Presence, now: number): Alert | null {
  if (peer.sessionId === me.sessionId || peer.repoKey !== me.repoKey) return null
  if (!isLive(peer, now)) return null

  const mine = recent(me.files, now)
  const theirs = new Set(recent(peer.files, now))
  const overlap = mine.filter(f => theirs.has(f)).sort()
  const bothHot = mine.some(isHot) && [...theirs].some(isHot)
  const sameCheckout = peer.toplevel === me.toplevel

  const [level, kind]: [Level, AlertKind] =
    overlap.length > 0 ? [3, 'overlap'] : bothHot ? [3, 'hot'] : sameCheckout ? [2, 'checkout'] : [1, 'repo']

  return {
    sessionId: peer.sessionId,
    level,
    kind,
    title: peer.title ?? '',
    hostId: isHostId(peer.hostId) ? peer.hostId : '',
    task: peer.task,
    branch: peer.branch,
    overlap,
  }
}

export function assessAll(me: Presence, peers: Presence[], now: number): Alert[] {
  return peers
    .map(p => assess(me, p, now))
    .filter((a): a is Alert => a !== null)
    .sort((a, b) => b.level - a.level)
}

// Paths as git spells them: forward slashes, so Windows tool paths compare with `git rev-parse` output.
export const slashes = (path: string) => path.replace(/\\/g, '/')

/** The file relative to the repo's top level, or null when it lies outside it. */
export function repoRelative(toplevel: string, path: string): string | null {
  const root = slashes(toplevel).replace(/\/+$/, '') + '/'
  const file = slashes(path)
  return file.startsWith(root) ? file.slice(root.length) : null
}

export const reasonOf = (w: Words, a: Alert) => w.reason(a.kind, a.overlap.length)

const list = (w: Words, xs: string[], max = 8) =>
  xs.length === 0 ? w.none : xs.slice(0, max).join(', ') + (xs.length > max ? ` (+${xs.length - max})` : '')

const quote = (w: Words, s: string) => (s ? `«${s}»` : w.noTask)

/** How a session is named to the person: its sidebar title, else the start of what it was asked. */
export const nameOf = (w: Words, p: { title?: string; task: string }) => (p.title ? `«${p.title}»` : quote(w, p.task))

/** A desktop session id as the app spells it; anything else (from a peer's file) is never opened. */
export const isHostId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)

/** The desktop app's own link to a session, as its get_session answers it. */
export const sessionLink = (hostId: string) => `claude://claude.ai/epitaxy/${hostId}`

// What each peer session receives.
export function peerMessage(w: Words, me: Presence, alert: Alert, now: number): string {
  return w.peerMessage({
    repo: me.repoName,
    level: alert.level,
    reason: reasonOf(w, alert),
    id: me.sessionId,
    task: nameOf(w, me),
    branch: me.branch,
    path: me.toplevel,
    files: list(w, recent(me.files, now)),
    clash: alert.overlap.length ? list(w, alert.overlap) : null,
  })
}

// What the initiating session's own model is asked to do.
export function leadPrompt(w: Words, me: Presence, alerts: Alert[], sent: string[]): string {
  return [
    w.leadIntro(me.repoName),
    ...alerts.map(a =>
      w.leadRow({
        id: a.sessionId,
        level: a.level,
        reason: reasonOf(w, a),
        task: nameOf(w, a),
        branch: a.branch,
        clash: a.overlap.length ? list(w, a.overlap) : null,
        failed: !sent.includes(a.sessionId),
      }),
    ),
    w.leadClose,
  ].join('\n')
}

export function sameAlerts(a: Alert[], b: Alert[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
