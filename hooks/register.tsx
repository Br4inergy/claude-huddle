import { atom, read, update } from 'claude-code'
import type { EngineInterface as Api, Register, ToolCallResult } from 'claude-code'

import type { Alert, BandState, CoordResult } from '../types'
import { type Lang, type Words, inferLang, pickLang, words } from './i18n'
import {
  type Presence,
  type RepoEntry,
  type Snapshot,
  activeRepos,
  addMarker,
  compactForMidTurn,
  assessAll,
  bandState,
  diffSnapshots,
  dirsInCommand,
  huddleMarker,
  huddleMembers,
  isHostId,
  isLive,
  leadPrompt,
  leaderOf,
  liveHuddle,
  nameOf,
  newHuddleId,
  normalizeRemote,
  ownerKey,
  ownerOf,
  parseAddMarker,
  parseHuddleMarker,
  parsePorcelain,
  peerMessage,
  reasonOf,
  repoNameOf,
  repoRelative,
  resolvePath,
  sameJson,
  sessionLink,
  shouldRefreshTitle,
  slashes,
  stripMarkers,
  taskFromPrompt,
  upgradePresence,
  FILE_WINDOW_MS,
} from './logic'

const alerts = atom({ plugin: 'huddle', key: 'alerts' } as const, [] as Alert[])
const band = atom({ plugin: 'huddle', key: 'band' } as const, { kind: 'none' } as BandState)
const snoozeUntil = atom({ plugin: 'huddle', key: 'snoozeUntil' } as const, 0)
const lastCoord = atom({ plugin: 'huddle', key: 'lastCoord' } as const, null as CoordResult | null)

const TICK_MS = 15_000
const SNOOZE_MS = 30 * 60_000
const STALE_MS = 24 * 60 * 60_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const HUMAN_ORIGINS = new Set<string>(['composer', 'bridge', 'sdk'])
// The desktop app's own read of a session: its sidebar title. Asked only when it runs without a permission prompt.
const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
const LEVEL_MARK = { 1: '◦', 2: '▲', 3: '■' } as const
const LEVEL_COLOR = { 1: 'subtle', 2: 'warning', 3: 'error' } as const
// A shell command is watched in at most this many repos; git gets this long to list a repo's dirty files.
const SNAPSHOT_REPOS = 3
const SNAPSHOT_MS = 3000
const STAT_CAP = 300
const NEGATIVE_MS = 60_000
const PENDING_MAX = 5
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

// The module's own variables: a reload starts them over and session.start fills them again.
let me: Presence | null = null
let dir = ''
let homeDir = ''
let w: Words = words('en')
// What the person's own first prompt read as (Spanish or English), for when no setting says.
let inferred: Lang | null = null
// Peer+repo+level triples already toasted, so an alert is raised once per escalation.
const toasted = new Set<string>()
// Files already toasted as taken by another member of the huddle.
const warned = new Set<string>()
let ticks = 0
// The desktop app's id from the environment. A `claude -p` started from a desktop session inherits it, so it is
// taken as this session's own only once the session is drawn somewhere (a headless run never is).
let envHostId = ''
// A turn is running between prompt.submit and turn.complete: huddle messages are also copied into its next tool result.
let busy = false
let pending: string[] = []
// The peers as the last tick read them, for names and liveness between ticks.
let peersSeen: Presence[] = []
// directory -> its git top level ('' when it is not in a repo, remembered for a minute); top level -> repo identity.
const topCache = new Map<string, { top: string; at: number }>()
const identityCache = new Map<string, { repoKey: string; repoName: string }>()

/** Claude Code's `language` setting, then what the person writes, then LC_ALL/LANG; English by default. */
async function detectLang($: Api): Promise<Lang> {
  const settings = (await $.settings.read().catch(() => ({}))) as { language?: unknown }
  const locale = (await $.env.get('LC_ALL').catch(() => null)) || (await $.env.get('LANG').catch(() => null)) || null
  return pickLang(undefined, settings.language, locale, inferred)
}

async function git($: Api, cwd: string, args: string[]) {
  const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 5000 })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

/** `git -C <dir> ...`, '' on any failure (no such directory, not a repo, timeout). */
async function gitC($: Api, where: string, args: string[]) {
  const r = await $.process.run(['git', '-C', where, ...args], { timeoutMs: 5000 }).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim() : ''
}

async function save($: Api) {
  if (!me) return
  const now = await $.clock.now()
  me.lastSeen = now
  me.repos[me.home]!.seenAt = now
  // Only what still counts is kept: files edited in the last 4 hours, repos seen in the last 4 hours.
  for (const [key, repo] of Object.entries(me.repos)) {
    for (const [file, at] of Object.entries(repo.files)) if (now - at >= FILE_WINDOW_MS) delete repo.files[file]
    if (key !== me.home && now - (repo.seenAt ?? 0) >= FILE_WINDOW_MS) delete me.repos[key]
  }
  await $.fs.write(`${dir}/${me.sessionId}.json`, JSON.stringify(me))
}

async function readPeers($: Api, now: number): Promise<Presence[]> {
  const peers: Presence[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    const path = `${dir}/${entry.name}`
    try {
      const text = await $.fs.read(path)
      if (!text) continue
      const p = upgradePresence(JSON.parse(text))
      if (!p) continue
      if (now - p.lastSeen > STALE_MS) {
        // No delete in $.fs: a session gone for a day is emptied, and an empty file is skipped.
        await $.fs.write(path, '').catch(() => null)
        continue
      }
      peers.push(p)
    } catch {
      // half-written by a peer this instant, or emptied when stale; the next tick reads it
    }
  }
  peersSeen = peers
  return peers
}

/** This session's sidebar title from the desktop app, when the app is there and lets it be read without asking. */
async function refreshTitle($: Api) {
  if (!me?.hostId) return
  const tools = await $.tool.list()
  if (!tools.some(t => t.name === GET_SESSION)) return
  const input = { tool: GET_SESSION, session_id: 'self' } as never
  const { decision } = await $.tool.check(input)
  if (decision !== 'allow') return
  const { text } = (await $.tool.call(input)) as { text?: string }
  const title = text ? (JSON.parse(text) as { title?: unknown }).title : undefined
  if (typeof title === 'string' && title.trim()) me.title = title.trim().slice(0, 120)
}

/** Opens a session of the desktop app by its own link, through the OS: the band may be drawn where links can't. */
async function openSession($: Api, hostId: string) {
  // `start` goes through cmd on Windows: only an id the app could have written reaches it.
  if (!isHostId(hostId)) return
  const url = sessionLink(hostId)
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const tries = isWindows ? [['cmd', '/c', 'start', '', url]] : [['open', url], ['xdg-open', url]]
  for (const argv of tries) {
    const r = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => null)
    if (r?.exitCode === 0) return
  }
  $.ui.toast(w.openFailed)
}

// ---- Repos: which one a file or a directory belongs to ----

/** The git top level of a directory (or of the nearest parent that is a repo, for a folder a Write is about to
 * create); '' when it is in none. Remembered per directory. */
async function toplevelOf($: Api, start: string): Promise<string> {
  const now = await $.clock.now()
  let d = slashes(start)
  const tried: string[] = []
  for (let i = 0; i < 5 && d; i++) {
    const hit = topCache.get(d)
    let top = ''
    if (hit && (hit.top || now - hit.at < NEGATIVE_MS)) top = hit.top
    else {
      top = slashes(await gitC($, d, ['rev-parse', '--show-toplevel']))
      topCache.set(d, { top, at: now })
    }
    if (top) {
      for (const t of tried) topCache.set(t, { top, at: now })
      return top
    }
    tried.push(d)
    const parent = d.replace(/\/[^/]*$/, '')
    if (!parent || parent === d) break
    d = parent
  }
  return ''
}

/** A repo's key and name: its normalized origin, else its absolute git directory (as session.start does). */
async function identityOf($: Api, toplevel: string): Promise<{ repoKey: string; repoName: string }> {
  const cached = identityCache.get(toplevel)
  if (cached) return cached
  const remote = await gitC($, toplevel, ['config', '--get', 'remote.origin.url'])
  const commonDir = remote ? '' : await gitC($, toplevel, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const repoKey = remote ? normalizeRemote(remote) : slashes(commonDir || toplevel)
  const id = { repoKey, repoName: repoNameOf(repoKey, toplevel) }
  if (identityCache.size > 200) identityCache.clear()
  identityCache.set(toplevel, id)
  return id
}

/** The session's entry for the repo at `toplevel`, made when it is the first time it is edited or entered. */
async function noteRepo($: Api, toplevel: string, now: number): Promise<RepoEntry | null> {
  if (!me || !toplevel) return null
  const byTop = Object.values(me.repos).find(r => r.toplevel === toplevel)
  const known = byTop ?? me.repos[(await identityOf($, toplevel)).repoKey]
  if (known) {
    known.seenAt = now
    return known
  }
  const id = await identityOf($, toplevel)
  const entry: RepoEntry = {
    ...id,
    toplevel,
    branch: await gitC($, toplevel, ['rev-parse', '--abbrev-ref', 'HEAD']),
    files: {},
    seenAt: now,
  }
  me.repos[id.repoKey] = entry
  return entry
}

// ---- Edits: through the file tools, and through the shell (what a command changed in the repos it works in) ----

type Hit = { repoKey: string; repoName: string; rel: string }
type Watched = { top: string; entry: RepoEntry; snap: Snapshot | null; startedAt: number }

/** One repo's dirty files and, for at most 300 of them, a signature of mtime and size. Null when git can't say. */
async function snapshot($: Api, top: string, prefer?: Snapshot | null): Promise<Snapshot | null> {
  const r = await $.process
    .run(['git', '-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { timeoutMs: SNAPSHOT_MS })
    .catch(() => null)
  if (!r || r.exitCode !== 0) return null
  const status = parsePorcelain(r.stdout)
  const snap: Snapshot = {}
  for (const [path, st] of Object.entries(status)) snap[path] = { status: st }
  // The files the first snapshot signed come first, so the two can be compared.
  const paths = Object.keys(snap).sort((a, b) => Number(prefer?.[b]?.sig !== undefined) - Number(prefer?.[a]?.sig !== undefined))
  await Promise.all(
    paths.slice(0, STAT_CAP).map(async path => {
      const st = await $.fs.stat(`${top}/${path}`).catch(() => null)
      if (st) snap[path]!.sig = `${st.mtimeMs}:${st.size}`
    }),
  )
  return snap
}

/** Before a shell command: the repos to watch (home, the directories it names, those visited in the last 4 h),
 * each with its dirty files. A command that enters a repo makes this session visit it. */
async function beforeBash($: Api, command: string): Promise<Watched[]> {
  if (!me) return []
  const now = await $.clock.now()
  const cwd = slashes(await $.session.cwd().catch(() => me!.cwd))
  const named = new Set<string>()
  for (const d of dirsInCommand(command, cwd, homeDir).slice(0, 6)) {
    const top = await toplevelOf($, d)
    if (top) named.add(top)
  }
  const tops = [me.repos[me.home]!.toplevel]
  for (const top of named) tops.push(top)
  const recent = Object.values(me.repos)
    .filter(r => r.repoKey !== me!.home && now - (r.seenAt ?? 0) < FILE_WINDOW_MS)
    .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))
  for (const r of recent) tops.push(r.toplevel)

  const watched: Watched[] = []
  let entered = false
  for (const top of named) {
    const before = Object.keys(me.repos).length
    await noteRepo($, top, now)
    if (Object.keys(me.repos).length !== before) entered = true
  }
  for (const top of [...new Set(tops)].slice(0, SNAPSHOT_REPOS)) {
    const entry = Object.values(me.repos).find(r => r.toplevel === top) ?? (await noteRepo($, top, now))
    if (entry) watched.push({ top, entry, snap: null, startedAt: now })
  }
  await Promise.all(watched.map(async t => (t.snap = await snapshot($, t.top))))
  if (entered) save($).catch(() => {})
  return watched
}

/** After it: what changed in those repos is this session's edit. */
async function afterBash($: Api, watched: Watched[]): Promise<Hit[]> {
  const now = await $.clock.now()
  const hits: Hit[] = []
  if (!watched.some(t => t.snap)) return hits
  const peers = (await readPeers($, now).catch(() => peersSeen)).filter(p => p.sessionId !== me?.sessionId && isLive(p, now))
  await Promise.all(
    watched.map(async t => {
      if (!t.snap) return
      const after = await snapshot($, t.top, t.snap)
      if (!after) return
      for (const rel of diffSnapshots(t.snap, after)) {
        // In a shared working copy another session may have written meanwhile: what it recorded is not ours.
        if (peers.some(p => (p.repos[t.entry.repoKey]?.files[rel] ?? 0) >= t.startedAt)) continue
        t.entry.files[rel] = now
        t.entry.seenAt = now
        hits.push({ repoKey: t.entry.repoKey, repoName: t.entry.repoName, rel })
      }
    }),
  )
  return hits
}

/** A write through Edit/Write/MultiEdit/NotebookEdit: the file's own repo, wherever it is. */
async function afterEdit($: Api, input: { file_path?: string; notebook_path?: string }): Promise<Hit[]> {
  if (!me) return []
  const given = input.file_path ?? input.notebook_path
  if (!given) return []
  const path = resolvePath(slashes(await $.session.cwd().catch(() => me!.cwd)), given)
  const top = await toplevelOf($, path.replace(/\/[^/]*$/, '') || '/')
  const now = await $.clock.now()
  const entry = await noteRepo($, top, now)
  if (!entry) return []
  let rel = repoRelative(top, path)
  if (!rel) {
    // git spells the top level with symbolic links resolved; the tool may not have.
    const real = (await $.fs.stat(path, { resolve: true }).catch(() => null))?.realPath
    rel = real ? repoRelative(top, real) : null
  }
  if (!rel) return []
  entry.files[rel] = now
  return [{ repoKey: entry.repoKey, repoName: entry.repoName, rel }]
}

// ---- Huddle ----

/** The leader's lead as it is now on disk (a member reads it fresh: the agreement may be seconds old). */
async function currentLead($: Api) {
  if (!me?.huddle) return undefined
  if (me.huddle.leaderId === me.sessionId) return me.huddle.lead
  try {
    return upgradePresence(JSON.parse(await $.fs.read(`${dir}/${me.huddle.leaderId}.json`)))?.huddle?.lead
  } catch {
    return leaderOf(me, peersSeen)?.huddle?.lead
  }
}

/** Notes for edits that fall on a file the agreement gave to another live member; a toast the first time per file. */
async function ownerNotes($: Api, hits: Hit[]): Promise<string[]> {
  if (!me || hits.length === 0 || !me.huddle) return []
  const lead = await currentLead($)
  if (!lead) return []
  const now = await $.clock.now()
  const notes: string[] = []
  for (const hit of hits) {
    const ownerId = ownerOf(lead, hit.repoKey, hit.rel)
    if (!ownerId || ownerId === me.sessionId) continue
    const owner = peersSeen.find(p => p.sessionId === ownerId)
    if (!owner || !isLive(owner, now)) continue
    const name = nameOf(w, owner)
    notes.push(w.ownerConflict(hit.rel, name))
    const key = ownerKey(hit.repoKey, hit.rel)
    if (!warned.has(key)) {
      warned.add(key)
      $.ui.toast(w.toastOwner(hit.rel, name))
    }
  }
  return notes
}

/** A member's first message to anyone after joining confirms the huddle. */
async function markAck($: Api) {
  const h = me?.huddle
  if (!me || !h || h.leaderId === me.sessionId || h.ackAt) return
  h.ackAt = await $.clock.now()
  await save($)
}

async function onReceive($: Api, e: { text: string }) {
  if (!me) return
  const now = await $.clock.now()
  const add = parseAddMarker(e.text)
  const lead = me.huddle?.leaderId === me.sessionId ? me.huddle.lead : undefined
  if (add && lead && me.huddle?.id === add.id) {
    lead.members = [...new Set([...lead.members, ...add.sessionIds.filter(id => id !== me!.sessionId)])]
    await save($)
  }
  const marker = parseHuddleMarker(e.text)
  if (marker && marker.leaderId !== me.sessionId) {
    // A leader keeps its own huddle; anyone else follows the latest one that reached it.
    const mine = me.huddle
    if (!mine || (mine.id !== marker.id && mine.leaderId !== me.sessionId)) {
      me.huddle = { id: marker.id, leaderId: marker.leaderId, joinedAt: now }
      await save($)
    }
  }
  if (busy && (marker || add)) {
    const leader = marker && peersSeen.find(p => p.sessionId === marker.leaderId)
    const from = leader ? nameOf(w, leader) : w.aMember
    pending = [...pending, w.midTurnNote(from, compactForMidTurn(e.text))].slice(-PENDING_MAX)
  }
}

async function onPrompt($: Api, e: { text: string; origin: { kind: string } }) {
  busy = true
  if (!me || !HUMAN_ORIGINS.has(e.origin.kind)) return
  me.lastActiveAt = await $.clock.now()
  const task = taskFromPrompt(e.text)
  if (task && !me.task) {
    me.task = task
    // The first thing the person types says which language they work in.
    inferred = inferLang(e.text.slice(0, 2000)) ?? inferred
    envHostId = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) || ''
    const lang = await detectLang($)
    w = words(lang)
    me.lang = lang
  }
  save($).catch(() => {})
}

/** What a tool call adds after it ran: ownership notes for what it edited, and huddle messages that arrived mid-turn. */
async function afterTool(
  $: Api,
  e: { tool: string; agentId?: string; file_path?: string; notebook_path?: string },
  ran: ToolCallResult,
  watched: Watched[],
): Promise<ToolCallResult> {
  if (ran.deny !== undefined) return ran
  const notes: string[] = []
  let hits: Hit[] = []
  if (e.tool === 'Bash') hits = await afterBash($, watched)
  else if (EDIT_TOOLS.has(e.tool) && !ran.isError) hits = await afterEdit($, e)
  if (hits.length) {
    notes.push(...(await ownerNotes($, hits)))
    save($).catch(() => {})
    refresh($).catch(() => {})
  }
  if (!e.agentId && pending.length) {
    notes.push(...pending)
    pending = []
  }
  return notes.length ? { ...ran, context: [...(ran.context ?? []), ...notes] } : ran
}

/** One look at the peers. `timer` marks the clock's own tick: only those count toward re-reading the title. */
async function refresh($: Api, timer = false) {
  if (!me) return
  if (!me.hostId && isHostId(envHostId) && (await $.session.surfaces().catch(() => [])).length > 0) me.hostId = envHostId
  if (timer && shouldRefreshTitle(ticks++)) await refreshTitle($).catch(() => {})
  const now = await $.clock.now()
  await Promise.all(
    activeRepos(me, now)
      .slice(0, 5)
      .map(async r => (r.branch = (await gitC($, r.toplevel, ['rev-parse', '--abbrev-ref', 'HEAD'])) || r.branch)),
  )
  await save($)
  const peers = await readPeers($, now)
  // A huddle nobody in it keeps alive is over (unless this session only just joined and the leader's file is not in yet).
  if (me.huddle && now - me.huddle.joinedAt > 2 * 60_000 && !liveHuddle(me, peers, now)) me.huddle = undefined

  const all = assessAll(me, peers, now)
  const state = bandState(me, peers, now)
  if (!sameJson(await read($, alerts), all)) await update($, alerts, () => all)
  if (!sameJson(await read($, band), state)) await update($, band, () => state)

  if (state.kind === 'alert') {
    const snoozed = (await read($, snoozeUntil)) > now
    for (const a of state.alerts) {
      const key = `${a.sessionId}:${a.repoKey}:${a.level}`
      if (a.level < 3 || toasted.has(key) || snoozed) continue
      toasted.add(key)
      $.ui.toast(w.toastClash(a.repoName, reasonOf(w, a)))
    }
    $.ui.status(w.status(state.alerts.length + 1, state.alerts[0]!.repoName))
  } else {
    $.ui.status(state.kind === 'huddle' ? w.statusHuddle(state.size) : undefined)
  }
}

/** Starts a huddle with every live peer in the shared repos, or adds those who are not yet in the one that is live.
 * Answers what the toast says. */
async function coordinate($: Api): Promise<string> {
  if (!me) return w.commandNotRepo
  // Titles are what the person sees in the messages: take this session's and the peers' as they are now.
  await refreshTitle($).catch(() => {})
  const now = await $.clock.now()
  const peers = await readPeers($, now)
  const current = assessAll(me, peers, now)
  const members = huddleMembers(me, peers, now)
  const targets = current.filter(a => !members?.has(a.sessionId))
  if (targets.length === 0) {
    const told = current.length ? w.toastAllIn : w.toastNoPeers
    $.ui.toast(told)
    return told
  }
  if (!members) {
    me.huddle = {
      id: newHuddleId(me.sessionId, now),
      leaderId: me.sessionId,
      joinedAt: now,
      lead: { members: [], owners: {}, createdAt: now },
    }
  }
  const h = me.huddle!
  const isLeader = h.leaderId === me.sessionId
  if (isLeader && !h.lead) h.lead = { members: [], owners: {}, createdAt: now }

  const sent: string[] = []
  const failed: string[] = []
  for (const a of targets) {
    const r = await $.session
      .send({ to: { sessionId: a.sessionId }, text: peerMessage(w, me, a, now, { id: h.id, leaderId: h.leaderId }) })
      .catch(err => ({ isDelivered: false as const, reason: String(err) }))
    if (r.isDelivered) sent.push(a.sessionId)
    else failed.push(`${a.sessionId.slice(0, 8)}: ${r.reason}`)
  }
  const names = targets.filter(a => sent.includes(a.sessionId)).map(a => nameOf(w, a)).join(', ')
  if (sent.length) {
    if (isLeader) h.lead!.members = [...new Set([...h.lead!.members, ...sent])]
    // A member that adds tells the leader, who keeps the list and takes the replies.
    else void $.session.send({ to: { sessionId: h.leaderId }, text: w.addedNotice(names, addMarker(h.id, sent)) }).catch(() => null)
  }
  await save($)
  await update($, lastCoord, () => ({ at: now, sent: sent.length, failed }))
  const told = failed.length ? w.toastPartial(sent.length, failed.length) : members ? w.toastAdded(sent.length) : w.toastSent(sent.length)
  $.ui.toast(told)
  if (!members) void $.prompt.submit({ text: leadPrompt(w, me, targets, sent) })
  else if (isLeader && sent.length) void $.prompt.submit({ text: w.leadAdded(names) })
  refresh($).catch(() => {})
  return told
}

type AgreeInput = { summary?: unknown; owners?: unknown }

/** The `agree` tool: the leader records who owns which file and tells every member. */
async function agree($: Api, input: AgreeInput): Promise<{ result: string } | { deny: string }> {
  const h = me?.huddle
  if (!me || !h) return { deny: w.agreeNoHuddle }
  if (h.leaderId !== me.sessionId || !h.lead) return { deny: w.agreeNotLeader }
  const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
  const given = Array.isArray(input.owners) ? (input.owners as { repo?: unknown; path?: unknown; sessionId?: unknown }[]) : []
  if (!summary || given.length === 0) return { deny: w.agreeBadInput }

  const now = await $.clock.now()
  const peers = await readPeers($, now)
  const everyone = [me, ...peers]
  const repos = everyone.flatMap(p => Object.values(p.repos))
  const owners: Record<string, string> = {}
  const lines: string[] = []
  for (const o of given) {
    const sessionId = typeof o.sessionId === 'string' ? o.sessionId : ''
    let path = typeof o.path === 'string' ? slashes(o.path).replace(/^\.\//, '') : ''
    if (!ID_RE.test(sessionId) || !path) return { deny: w.agreeBadInput }
    const asked = typeof o.repo === 'string' ? o.repo.trim() : ''
    let repo = asked
      ? repos.find(r => r.repoKey === asked) ?? repos.find(r => r.repoName.toLowerCase() === asked.toLowerCase())
      : me.repos[me.home]
    if (!repo) return { deny: w.agreeBadRepo(asked) }
    if (!asked) {
      // An absolute path names its own repo.
      const inside = repos.find(r => repoRelative(r.toplevel, path) !== null)
      if (inside && path.startsWith('/')) repo = inside
    }
    path = repoRelative(repo.toplevel, path) ?? path
    owners[ownerKey(repo.repoKey, path)] = sessionId
    const owner = everyone.find(p => p.sessionId === sessionId)
    lines.push(`- ${repo.repoName}/${path} → ${owner ? nameOf(w, owner) : sessionId.slice(0, 8)} (${sessionId})`)
  }

  h.lead.owners = owners
  h.lead.summary = summary
  h.lead.agreedAt = now
  const text = w.agreeMessage({ summary, owners: lines, marker: huddleMarker(h.id, me.sessionId) })
  const memberIds = new Set([...h.lead.members, ...peers.filter(p => p.huddle?.id === h.id).map(p => p.sessionId)])
  memberIds.delete(me.sessionId)
  let sent = 0
  let failed = 0
  for (const id of memberIds) {
    if (!peers.some(p => p.sessionId === id && isLive(p, now))) continue
    const r = await $.session.send({ to: { sessionId: id }, text }).catch(() => ({ isDelivered: false as const }))
    if (r.isDelivered) sent++
    else failed++
  }
  await save($)
  refresh($).catch(() => {})
  return { result: w.agreeDone(sent, failed) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const cwd = await $.session.cwd()
    const toplevel = await git($, cwd, ['rev-parse', '--show-toplevel'])
    if (!toplevel) {
      w = words(await detectLang($))
      return started
    }

    const commonDir = await git($, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const remote = await git($, cwd, ['config', '--get', 'remote.origin.url'])
    const repoKey = remote ? normalizeRemote(remote) : slashes(commonDir)
    const now = await $.clock.now()
    homeDir = slashes((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '')
    dir = `${homeDir}/.claude/huddle/sessions`

    const home: RepoEntry = {
      repoKey,
      repoName: repoNameOf(repoKey, slashes(toplevel)),
      toplevel: slashes(toplevel),
      branch: await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      files: {},
      seenAt: now,
    }
    me = {
      v: 2,
      sessionId: await $.session.id(),
      cwd,
      home: repoKey,
      repos: { [repoKey]: home },
      task: '',
      hostId: undefined,
      startedAt: now,
      lastSeen: now,
      lastActiveAt: now,
    }
    // A reload keeps the session: pick up what this session already recorded.
    try {
      const saved = upgradePresence(JSON.parse(await $.fs.read(`${dir}/${me.sessionId}.json`)))
      if (saved) {
        me.task = saved.task
        me.title = saved.title
        me.huddle = saved.huddle
        me.startedAt = saved.startedAt
        me.lastActiveAt = saved.lastActiveAt
        me.repos = { ...saved.repos, [repoKey]: { ...home, files: saved.repos[repoKey]?.files ?? {} } }
        if (saved.task) inferred = inferLang(saved.task)
      }
    } catch {
      // first start
    }
    const lang = await detectLang($)
    w = words(lang)
    me.lang = lang

    await $.command.register({ name: 'huddle', description: w.commandDescription })
    await $.tool.register({ name: 'peers', description: w.toolPeers })
    await $.tool.register({
      name: 'send',
      description: w.toolSend,
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string' }, text: { type: 'string' } },
        required: ['sessionId', 'text'],
      },
    })
    await $.tool.register({
      name: 'agree',
      description: w.toolAgree,
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          owners: {
            type: 'array',
            items: {
              type: 'object',
              properties: { repo: { type: 'string' }, path: { type: 'string' }, sessionId: { type: 'string' } },
              required: ['path', 'sessionId'],
            },
          },
        },
        required: ['summary', 'owners'],
      },
    })

    await refresh($, true)
    $.clock.every(TICK_MS, () => void refresh($, true).catch(() => {}))
    return started
  })

  on('command.run', { command: 'huddle' }, async $ => ({ text: await coordinate($) }))

  on('prompt.submit', async ($, e, next) => {
    // The task is what a person asked: typed, sent from a phone or an SDK host; never a peer's or a plugin's text.
    await onPrompt($, e).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) busy = false
    return next(e)
  })

  // Outside the desktop app the title comes with the prompt (a /rename in the terminal, say).
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (me && e.session_title && e.session_title !== me.title) {
      me.title = e.session_title.slice(0, 120)
      save($).catch(() => {})
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A shell command is looked at before and after: what changed in between is this session's edit.
    let watched: Watched[] = []
    try {
      if (me) {
        me.lastActiveAt = await $.clock.now()
        if (e.tool === 'Bash') watched = await beforeBash($, e.command)
      }
    } catch {
      // watching is best effort; the command still runs
    }
    const ran = await next(e)
    if (!me) return ran
    // Recording never changes the tool's result: the edit already happened.
    return afterTool($, e as never, ran, watched).catch(() => ran)
  })

  on('tool.call', { tool: 'mcp__huddle__peers' }, async $ => {
    try {
      const list = await read($, alerts)
      return { result: list.length ? JSON.stringify(list, null, 2) : w.peersNone }
    } catch (err) {
      return { deny: `huddle: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'mcp__huddle__send' }, async ($, e) => {
    const { sessionId, text } = e as unknown as { sessionId: string; text: string }
    try {
      const r = await $.session.send({ to: { sessionId }, text })
      if (r.isDelivered) await markAck($).catch(() => {})
      return r.isDelivered ? { result: w.delivered } : { deny: w.notDelivered(r.reason) }
    } catch (err) {
      return { deny: w.notDelivered(String(err)) }
    }
  })

  on('tool.call', { tool: 'mcp__huddle__agree' }, async ($, e) => {
    try {
      return await agree($, e as unknown as AgreeInput)
    } catch (err) {
      return { deny: `huddle: ${String(err)}` }
    }
  })

  // Joining a huddle is a matter of reading its marker; the message itself is always delivered.
  on('session.receive', async ($, e, next) => {
    await onReceive($, e).catch(() => {})
    return next(e)
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    if (r.isDelivered) await markAck($).catch(() => {})
    return r
  })

  on('session.end', async ($, e, next) => {
    if (me) {
      me.ended = true
      await save($).catch(() => {})
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, band)
    const now = await $.clock.now()
    if (!me || e.props.hasSurvey || state.kind === 'none') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)

    if (state.kind === 'huddle') {
      const led = state.leader
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Text color="success">
              ✓ {w.huddleWith(state.size)} · {state.leaderIsMe ? w.ledByYou : w.ledBy}
            </Text>
            {!state.leaderIsMe &&
              (led.hostId ? (
                <Button key="open-leader" plain onPress={() => openSession($, led.hostId)}>
                  <Text color="success" underline>
                    {nameOf(w, led)}
                  </Text>
                </Button>
              ) : (
                <Text color="success">{nameOf(w, led)}</Text>
              ))}
            <Text dimColor>· {w.confirmed(state.confirmed, state.size)}</Text>
          </Box>
          {state.conflicts.slice(0, 2).map(c => (
            <Text color="warning" dimColor>
              ▲ {w.editedOwned(nameOf(w, c.editor), c.file, nameOf(w, c.owner))}
            </Text>
          ))}
        </Box>
      )
    }

    if ((await read($, snoozeUntil)) > now) return next(e)
    const list = state.alerts
    const top = list[0]!.level
    const done = await read($, lastCoord)

    return (
      <Box flexDirection="column" marginTop={1}>
        {list.slice(0, 3).map(a => (
          <Box flexDirection="row" gap={1}>
            <Text color={LEVEL_COLOR[a.level]}>
              {LEVEL_MARK[a.level]} {a.level === 3 ? w.clash : w.otherAgent} {w.in} {a.repoName} · {reasonOf(w, a)}
              {a.overlap.length ? ` (${a.overlap.slice(0, 3).join(', ')}${a.overlap.length > 3 ? '…' : ''})` : ''} ·
            </Text>
            {a.hostId ? (
              <Button key={`open-${a.sessionId}`} plain onPress={() => openSession($, a.hostId)}>
                <Text color={LEVEL_COLOR[a.level]} underline>
                  {nameOf(w, { title: a.title, task: a.task.slice(0, 60) })}
                </Text>
              </Button>
            ) : (
              <Text color={LEVEL_COLOR[a.level]}>{nameOf(w, { title: a.title, task: a.task.slice(0, 60) })}</Text>
            )}
            <Text dimColor>· {a.branch}</Text>
          </Box>
        ))}
        {list.length > 3 && <Text dimColor>  {w.more(list.length - 3)}</Text>}
        <Box flexDirection="row" gap={1}>
          {top === 3 && <Text color="error" bold>{w.recommend}</Text>}
          <Button key="coord" variant={top === 3 ? 'primary' : undefined} onPress={() => coordinate($)}>
            {state.hasHuddle ? w.addToHuddle : w.coordinate}
          </Button>
          <Button key="snooze" onPress={() => update($, snoozeUntil, () => now + SNOOZE_MS)}>
            {w.snooze}
          </Button>
          {done && now - done.at < 10 * 60_000 && (
            <Text dimColor>
              {w.sentTo(done.sent)}
              {done.failed.length ? w.failedN(done.failed.length) : ''}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
