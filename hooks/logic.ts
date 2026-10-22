import type { Alert, AlertKind, BandState, Family, Level, OwnerConflict, Who } from '../types'
import type { Lang, Words } from './i18n'

/** What a session knows of one repo it works in: its working copy there, its branch, the files it edited. */
export type RepoEntry = {
  repoKey: string
  repoName: string
  toplevel: string
  branch: string
  files: Record<string, number>
  /** When the session last edited or entered this repo. A repo not seen for the file window stops counting. */
  seenAt?: number
}

/** What the leader decided: who owns which disputed file. `owners` keys are `repoKey::relPath`. */
export type HuddleLead = {
  members: string[]
  owners: Record<string, string>
  summary?: string
  createdAt: number
  /** When `agree` last recorded the owners: only edits after it can break the agreement. */
  agreedAt?: number
}

export type HuddleInfo = {
  id: string
  leaderId: string
  joinedAt: number
  ackAt?: number
  lead?: HuddleLead
}

// One file per live session under ~/.claude/huddle/sessions/<sessionId>.json.
export type Presence = {
  v: 2
  sessionId: string
  cwd: string
  /** The repo of the session's working directory; always in `repos`. */
  home: string
  repos: Record<string, RepoEntry>
  task: string
  title?: string
  hostId?: string
  /** The desktop id of the session that started this one (start_session), while it is not detached. */
  parentHostId?: string
  lang?: Lang
  huddle?: HuddleInfo
  startedAt: number
  lastSeen: number
  /** Last human prompt or tool call: a session open but untouched for hours is idle. */
  lastActiveAt: number
  ended?: boolean
}

export const LIVE_MS = 60_000
export const FILE_WINDOW_MS = 4 * 60 * 60_000
export const IDLE_MS = 2 * 60 * 60_000

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

export const isIdle = (p: Presence, now: number): boolean => now - p.lastActiveAt > IDLE_MS

/**
 * A presence file as this version reads it. A session still on 0.2.x writes `v: 1` (one repo, flat); it is read as
 * a session whose only repo is its home. Anything else is skipped.
 */
export function upgradePresence(raw: unknown): Presence | null {
  const p = raw as Record<string, any> | null
  if (!p || typeof p !== 'object' || typeof p.sessionId !== 'string') return null
  if (p.v === 2) {
    if (!p.repos || typeof p.repos !== 'object' || typeof p.home !== 'string') return null
    return { ...p, lastActiveAt: typeof p.lastActiveAt === 'number' ? p.lastActiveAt : p.lastSeen } as Presence
  }
  if (p.v !== 1 || typeof p.repoKey !== 'string') return null
  const { files, toplevel, repoName, branch, repoKey, ...rest } = p
  return {
    ...rest,
    v: 2,
    home: repoKey,
    repos: { [repoKey]: { repoKey, repoName, toplevel, branch, files: files ?? {}, seenAt: p.lastSeen } },
    lastActiveAt: p.lastSeen,
  } as Presence
}

/** The repos that count right now: the home one always, the others while they were seen within the file window. */
export function activeRepos(p: Presence, now: number): RepoEntry[] {
  return Object.values(p.repos).filter(r => r.repoKey === p.home || now - (r.seenAt ?? p.lastSeen) < FILE_WINDOW_MS)
}

function assessRepo(mine: RepoEntry, theirs: RepoEntry, now: number): Pick<Alert, 'level' | 'kind' | 'overlap'> {
  const theirFiles = new Set(recent(theirs.files, now))
  const mineFiles = recent(mine.files, now)
  const overlap = mineFiles.filter(f => theirFiles.has(f)).sort()
  const bothHot = mineFiles.some(isHot) && [...theirFiles].some(isHot)
  const sameCheckout = mine.toplevel === theirs.toplevel
  const [level, kind]: [Level, AlertKind] =
    overlap.length > 0 ? [3, 'overlap'] : bothHot ? [3, 'hot'] : sameCheckout ? [2, 'checkout'] : [1, 'repo']
  return { level, kind, overlap }
}

/**
 * How two sessions clash. Every repo they both work in is judged on its own (same files 3, both on single-owner
 * files 3, same working copy 2, else 1) and the peer raises one alert, for its strongest repo.
 */
export function assess(me: Presence, peer: Presence, now: number): Alert | null {
  if (peer.sessionId === me.sessionId || !isLive(peer, now)) return null
  // A session and the one that started it (or one it started) already coordinate through the app.
  const family = familyOf(me, peer)
  if (family === 'mother' || family === 'daughter') return null

  const theirs = new Map(activeRepos(peer, now).map(r => [r.repoKey, r]))
  let best: { repo: RepoEntry; found: Pick<Alert, 'level' | 'kind' | 'overlap'> } | null = null
  for (const repo of activeRepos(me, now)) {
    const other = theirs.get(repo.repoKey)
    if (!other) continue
    const found = assessRepo(repo, other, now)
    const wins =
      !best ||
      found.level > best.found.level ||
      (found.level === best.found.level && found.overlap.length > best.found.overlap.length) ||
      (found.level === best.found.level && found.overlap.length === best.found.overlap.length && repo.repoKey === me.home)
    if (wins) best = { repo, found }
  }
  if (!best) return null
  // A session nobody has touched for hours only speaks up when the files already clash.
  if (isIdle(peer, now) && best.found.level < 3) return null
  // Sisters only speak up when their files clash.
  if (family === 'sister' && best.found.level < 3) return null

  const peerRepo = theirs.get(best.repo.repoKey)!
  return {
    sessionId: peer.sessionId,
    ...best.found,
    repoKey: best.repo.repoKey,
    repoName: best.repo.repoName,
    title: peer.title ?? '',
    hostId: isHostId(peer.hostId) ? peer.hostId : '',
    task: peer.task,
    branch: peerRepo.branch,
    ...(family === 'sister' ? { family } : {}),
  }
}

/**
 * The session's own title out of a `get_session` answer: the desktop app's (`{ title }`) or claude.ai's for a Remote
 * Control session (`{ ccr: { title } }`), at most 120 characters. '' when there is none.
 */
export function titleFromSessionAnswer(answer: unknown): string {
  const a = (answer ?? {}) as { title?: unknown; ccr?: { title?: unknown } }
  if (typeof a !== 'object') return ''
  const title = typeof a.title === 'string' ? a.title : typeof a.ccr?.title === 'string' ? a.ccr.title : ''
  return title.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** The session that started the one whose get_session answer this is; none once the person detached it. */
export function parentFromSession(answer: unknown): string | undefined {
  const a = answer as { parentSessionId?: unknown; detached?: unknown } | null
  if (!a || typeof a !== 'object' || a.detached === true) return undefined
  return isHostId(a.parentSessionId) ? a.parentSessionId : undefined
}

/** What `peer` is to `me` among sessions started from one another, by the desktop ids; null when unrelated or unknown. */
export function familyOf(me: Presence, peer: Presence): 'mother' | 'daughter' | 'sister' | null {
  if (me.parentHostId && me.parentHostId === peer.hostId) return 'mother'
  if (peer.parentHostId && peer.parentHostId === me.hostId) return 'daughter'
  if (me.parentHostId && me.parentHostId === peer.parentHostId) return 'sister'
  return null
}

/** The live session that started this one. */
export const motherOf = (me: Presence, peers: Presence[], now: number): Presence | undefined =>
  peers.find(p => p.sessionId !== me.sessionId && isLive(p, now) && familyOf(me, p) === 'mother')

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

export const reasonOf = (w: Words, a: Alert) =>
  w.reason(a.kind, a.overlap.length) + (a.family === 'sister' ? w.sisterSuffix : '')

const list = (w: Words, xs: string[], max = 8) =>
  xs.length === 0 ? w.none : xs.slice(0, max).join(', ') + (xs.length > max ? ` (+${xs.length - max})` : '')

const quote = (w: Words, s: string) => (s ? `«${s}»` : w.noTask)

/** How a session is named to the person: its sidebar title, else the start of what it was asked. */
export const nameOf = (w: Words, p: { title?: string; task: string }) => (p.title ? `«${p.title}»` : quote(w, p.task))

/** A desktop session id as the app spells it; anything else (from a peer's file) is never opened. */
export const isHostId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)

/** The prefix of the tools the Claude desktop app gives the sessions it hosts (`mcp__ccd_session__...`, `mcp__ccd_turn__...`). */
export const DESKTOP_TOOL_PREFIX = 'mcp__ccd_'

/**
 * Whether this process is a session someone sees, and so may take the desktop app's id from CLAUDE_CODE_HOST_SESSION_ID
 * as its own: it draws on a surface (terminal, phone, IDE, desktop) or the desktop app hosts it (its `mcp__ccd_*` tools
 * are there even while the session is not open in the window, when `surfaces()` is empty for hours). A `claude -p` run
 * started from a desktop session inherits the variable but neither of these, so it never passes for its parent. Once
 * true it stays true. If a desktop release ever hands its `ccd` servers to child processes, this needs another signal.
 */
export function isSeenSession(before: boolean, surfaces: readonly unknown[], toolNames: readonly string[]): boolean {
  return before || surfaces.length > 0 || toolNames.some(n => n.startsWith(DESKTOP_TOOL_PREFIX))
}

/**
 * Whether this session writes its presence file for the others to read. One someone sees always does. A run no one sees
 * (a `claude -p` helper that a status line, a mod or a script starts) only once it has edited something in a repo: until
 * then it is no risk to anyone, and showing it would put a nameless peer in every band of that repo.
 */
export function shouldPublish(seen: boolean, me: Pick<Presence, 'repos'>): boolean {
  return seen || Object.values(me.repos).some(r => Object.keys(r.files).length > 0)
}

/** The desktop app's own link to a session, as its get_session answers it. */
export const sessionLink = (hostId: string) => `claude://claude.ai/epitaxy/${hostId}`

/** The repo entry a message speaks about: the alert's repo, else the session's home. */
const entryFor = (p: Presence, repoKey: string): RepoEntry => p.repos[repoKey] ?? p.repos[p.home]!

// What each peer session receives. `huddle` is the huddle it joins: with none, this session leads a new one.
export function peerMessage(
  w: Words,
  me: Presence,
  alert: Alert,
  now: number,
  huddle?: { id: string; leaderId: string },
): string {
  const repo = entryFor(me, alert.repoKey)
  return w.peerMessage({
    repo: alert.repoName,
    level: alert.level,
    reason: reasonOf(w, alert),
    id: me.sessionId,
    task: nameOf(w, me),
    branch: repo.branch,
    path: repo.toplevel,
    files: list(w, recent(repo.files, now)),
    clash: alert.overlap.length ? list(w, alert.overlap) : null,
    leader: huddle?.leaderId ?? me.sessionId,
    marker: huddle ? huddleMarker(huddle.id, huddle.leaderId) : '',
  })
}

/** The one short notice a mother gets when two of her daughters edit the same files. */
export function sisterNotice(w: Words, me: Presence, sisters: Alert[]): string {
  const files = [...new Set(sisters.flatMap(a => a.overlap))].sort()
  return w.sisterClashToMother(
    nameOf(w, me),
    sisters.map(a => nameOf(w, a)).join(', '),
    files.length ? list(w, files) : w.none,
  )
}

// What the initiating session's own model is asked to do.
export function leadPrompt(w: Words, me: Presence, alerts: Alert[], sent: string[]): string {
  const repos = [...new Set(alerts.map(a => a.repoName))].join(', ')
  return [
    w.leadIntro(repos),
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

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export const sameAlerts = (a: Alert[], b: Alert[]): boolean => sameJson(a, b)

// ---- Huddle: the marker line every protocol message carries, so the receiving side knows it joined. ----

const ID = '[A-Za-z0-9_-]{1,80}'
const MARKER = new RegExp(`\\[huddle:(${ID}) leader:(${ID})\\]`)
const ADD_MARKER = new RegExp(`\\[huddle-add:(${ID}) ((?:${ID})(?:,${ID})*)\\]`)

export const huddleMarker = (id: string, leaderId: string) => `[huddle:${id} leader:${leaderId}]`
export const addMarker = (id: string, sessionIds: string[]) => `[huddle-add:${id} ${sessionIds.join(',')}]`

export function parseHuddleMarker(text: string): { id: string; leaderId: string } | null {
  const m = MARKER.exec(text)
  return m ? { id: m[1]!, leaderId: m[2]! } : null
}

export function parseAddMarker(text: string): { id: string; sessionIds: string[] } | null {
  const m = ADD_MARKER.exec(text)
  return m ? { id: m[1]!, sessionIds: m[2]!.split(',') } : null
}

/** The message without its machine lines, for the short copy a busy agent reads mid-turn. */
export const stripMarkers = (text: string): string =>
  text
    .split('\n')
    .filter(line => !MARKER.test(line) && !ADD_MARKER.test(line))
    .join('\n')
    .trim()

export const newHuddleId = (sessionId: string, now: number) => `${sessionId.slice(0, 8)}-${now}`

export const BACKGROUND_PREFIX = 'Background (from the session that started this one)'

/** What the session is "about": the start of what the person asked, never the text a parent session wrote to it. */
export function taskFromPrompt(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.startsWith(BACKGROUND_PREFIX) ? '' : t.slice(0, 140)
}

/** The sidebar title is read on every tick for the first 8, then every 4th. */
export const shouldRefreshTitle = (tick: number): boolean => tick < 8 || tick % 4 === 0

// ---- Shell edits: which directories a command enters, and what changed in a repo while it ran. ----

type Word = { text: string; dynamic: boolean }

/** A shell line as lists of words, one list per simple command. Quotes and `~`/`$HOME` are resolved; a word that
 * needs the shell to expand (`$X`, backticks, globs) is flagged dynamic. */
function splitCommand(command: string, home: string): Word[][] {
  const cmds: Word[][] = [[]]
  let cur = ''
  let has = false
  let dynamic = false
  let quote = ''
  const push = () => {
    if (has) cmds[cmds.length - 1]!.push({ text: cur, dynamic })
    cur = ''
    has = false
    dynamic = false
  }
  const cut = () => {
    push()
    if (cmds[cmds.length - 1]!.length) cmds.push([])
  }
  const homeAt = (i: number): number => {
    for (const name of ['HOME', '{HOME}']) {
      const end = i + 1 + name.length
      if (command.startsWith(name, i + 1) && (name.startsWith('{') || !/[A-Za-z0-9_]/.test(command[end] ?? ''))) return end
    }
    return -1
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") {
      if (c === "'") quote = ''
      else cur += c
      continue
    }
    if (c === '$') {
      const end = home ? homeAt(i) : -1
      if (end > 0) {
        cur += home
        has = true
        i = end - 1
      } else {
        dynamic = true
        has = true
        cur += c
      }
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '`') dynamic = true
      else if (c === '\\' && '"\\$`'.includes(command[i + 1] ?? ' ')) cur += command[++i]
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
    } else if (c === '\\') {
      if (command[i + 1] === '\n') i++
      else if (i + 1 < command.length) {
        cur += command[++i]
        has = true
      }
    } else if (c === '#' && !has) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++
    } else if (c === '~' && !has && home && (i + 1 >= command.length || /[/\s;&|)]/.test(command[i + 1]!))) {
      cur += home
      has = true
    } else if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') cut()
    else if (c === ' ' || c === '\t' || c === '\r') push()
    else {
      if (c === '*' || c === '?' || c === '[' || c === '`') dynamic = true
      cur += c
      has = true
    }
  }
  push()
  return cmds.filter(c => c.length)
}

/** `p` against `base`, `.` and `..` folded, forward slashes: no file system involved. */
export function resolvePath(base: string, p: string): string {
  const abs = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
  const full = slashes(abs || !base ? p : `${base}/${p}`)
  const prefix = /^([A-Za-z]:)?\//.exec(full)?.[0] ?? ''
  const stack: string[] = []
  for (const part of full.slice(prefix.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return prefix + stack.join('/')
}

/** The directories a command names with `cd`, `pushd` and `git -C`, as absolute paths, in order. A `cd` moves
 * the directory the later parts of the line are read against. */
export function dirsInCommand(command: string, cwd: string, home = ''): string[] {
  const out: string[] = []
  const add = (d: string) => {
    if (d && !out.includes(d)) out.push(d)
  }
  let running = slashes(cwd)
  for (const words of splitCommand(command, slashes(home))) {
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.text)) i++
    const head = words[i]?.text
    if (head === 'cd' || head === 'pushd') {
      const arg = words.slice(i + 1).find(x => !x.text.startsWith('-'))
      if (arg && !arg.dynamic) {
        running = resolvePath(running, arg.text)
        add(running)
      }
    } else if (head === 'git') {
      let base = running
      for (let j = i + 1; j < words.length; j++) {
        const t = words[j]!
        if (t.text === '-C') {
          const dir = words[++j]
          if (dir && !dir.dynamic) {
            base = resolvePath(base, dir.text)
            add(base)
          }
        } else if (t.text === '-c') j++
        else if (!t.text.startsWith('-')) break
      }
    }
  }
  return out
}

/** `git status --porcelain=v1 -z` as path -> two-letter status. A rename lists its old path after the new one. */
export function parsePorcelain(out: string, cap = 2000): Record<string, string> {
  const map: Record<string, string> = {}
  const parts = out.split('\0')
  let count = 0
  for (let i = 0; i < parts.length && count < cap; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    if (xy.includes('R') || xy.includes('C')) i++
    map[entry.slice(3)] = xy
    count++
  }
  return map
}

/** One repo's dirty files: git's status, and for some of them a signature of mtime and size. */
export type Snapshot = Record<string, { status: string; sig?: string }>

/** The paths that changed between two snapshots: a new status, a new signature, or not there before. A path that
 * left the list (committed, reverted) is not an edit. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = []
  for (const [path, a] of Object.entries(after)) {
    const b = before[path]
    if (!b || b.status !== a.status || (b.sig !== undefined && a.sig !== undefined && b.sig !== a.sig)) changed.push(path)
  }
  return changed.sort()
}

// ---- Huddle: who is in it, how the band reads it, who owns what. ----

export const ownerKey = (repoKey: string, rel: string) => `${repoKey}::${rel}`

/** The session the agreement gave this file to, if any. */
export const ownerOf = (lead: HuddleLead | undefined, repoKey: string, rel: string): string | undefined =>
  lead?.owners[ownerKey(repoKey, rel)]

/** The leader's presence: this session's own when it leads, else the peer's file. */
export function leaderOf(me: Presence, peers: Presence[]): Presence | null {
  const h = me.huddle
  if (!h) return null
  return h.leaderId === me.sessionId ? me : (peers.find(p => p.sessionId === h.leaderId) ?? null)
}

/** My huddle while it is live: its leader's presence is live, or another member was active in the last 4 h. */
export function liveHuddle(me: Presence, peers: Presence[], now: number): HuddleInfo | null {
  const h = me.huddle
  if (!h) return null
  if (h.leaderId === me.sessionId) return h
  const leader = peers.find(p => p.sessionId === h.leaderId)
  if (leader && isLive(leader, now)) return h
  const another = peers.some(
    p => p.sessionId !== me.sessionId && p.huddle?.id === h.id && !p.ended && now - p.lastActiveAt < FILE_WINDOW_MS,
  )
  return another ? h : null
}

/** Every session id in my live huddle (mine and the leader's included): who joined, plus whom the leader invited. */
export function huddleMembers(me: Presence, peers: Presence[], now: number): Set<string> | null {
  const h = liveHuddle(me, peers, now)
  if (!h) return null
  const ids = new Set<string>([me.sessionId, h.leaderId])
  for (const id of leaderOf(me, peers)?.huddle?.lead?.members ?? []) ids.add(id)
  for (const p of peers) if (p.huddle?.id === h.id) ids.add(p.sessionId)
  return ids
}

const who = (p: Presence): Who => ({
  title: p.title ?? '',
  task: p.task.slice(0, 60),
  hostId: isHostId(p.hostId) ? p.hostId : '',
})

/** Files a member edited after the agreement that the agreement gave to another member. */
export function ownerConflicts(lead: HuddleLead | undefined, members: Presence[], now: number): OwnerConflict[] {
  if (!lead?.agreedAt) return []
  const byId = new Map(members.map(m => [m.sessionId, m]))
  const found: { at: number; c: OwnerConflict }[] = []
  for (const editor of members) {
    for (const repo of Object.values(editor.repos)) {
      for (const [file, at] of Object.entries(repo.files)) {
        if (at <= lead.agreedAt! || now - at >= FILE_WINDOW_MS) continue
        const owner = byId.get(ownerOf(lead, repo.repoKey, file) ?? '')
        if (owner && owner.sessionId !== editor.sessionId) {
          found.push({ at, c: { editor: who(editor), owner: who(owner), repoName: repo.repoName, file } })
        }
      }
    }
  }
  return found.sort((a, b) => b.at - a.at).map(f => f.c)
}

/**
 * What the band shows. Peers that are live, not idle (unless their files clash) and share a repo are the ones to
 * speak of: if all of them are in my huddle it is one calm line, else the alert rows for those who are not.
 */
export function bandState(me: Presence, peers: Presence[], now: number): BandState {
  const alerts = assessAll(me, peers, now)
  const family = familyLine(me, peers, now)
  if (alerts.length === 0) return family ? { kind: 'family', family } : { kind: 'none' }
  const members = huddleMembers(me, peers, now)
  const outsiders = alerts.filter(a => !members?.has(a.sessionId))
  if (outsiders.length > 0) return { kind: 'alert', alerts: outsiders, hasHuddle: members !== null, ...(family ? { family } : {}) }

  const inAlert = new Set(alerts.map(a => a.sessionId))
  // A mother or a daughter takes no part in the huddle, even if a marker reached it.
  const others = peers.filter(
    p =>
      members!.has(p.sessionId) &&
      isLive(p, now) &&
      (!isIdle(p, now) || inAlert.has(p.sessionId)) &&
      !['mother', 'daughter'].includes(familyOf(me, p) ?? ''),
  )
  const h = me.huddle!
  const leader = leaderOf(me, peers)
  const confirmed =
    (h.leaderId === me.sessionId || h.ackAt ? 1 : 0) + others.filter(p => p.sessionId === h.leaderId || p.huddle?.ackAt).length
  return {
    kind: 'huddle',
    size: others.length + 1,
    confirmed,
    leader: leader ? who(leader) : { title: '', task: '', hostId: '' },
    leaderIsMe: h.leaderId === me.sessionId,
    conflicts: ownerConflicts(leader?.huddle?.lead, [me, ...others], now),
    ...(family ? { family } : {}),
  }
}

/** The live sessions of my family, for the dim line of the band; undefined when there are none. */
export function familyLine(me: Presence, peers: Presence[], now: number): Family | undefined {
  const mother = motherOf(me, peers, now)
  const daughters = peers.filter(p => p.sessionId !== me.sessionId && isLive(p, now) && familyOf(me, p) === 'daughter').length
  return mother || daughters ? { ...(mother ? { mother: who(mother) } : {}), daughters } : undefined
}

/** A repo's short name: the last part of its remote, or, with no remote (the key is its git directory), its folder. */
export function repoNameOf(repoKey: string, toplevel: string): string {
  const fromKey = repoKey.split('/').filter(Boolean).at(-1)?.replace(/\.git$/, '') ?? ''
  return fromKey || slashes(toplevel).split('/').filter(Boolean).at(-1) || toplevel
}

/** A huddle message cut to what a busy agent needs now: who, what clashes and how to answer. The protocol's later
 * points and the machine lines are left for the full message, which still arrives when the turn ends. */
export function compactForMidTurn(text: string, max = 1500): string {
  const lines = stripMarkers(text)
    .split('\n')
    .filter(line => !/^\s*[2-9]\.\s/.test(line))
  const out = lines.join('\n').trim()
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}
