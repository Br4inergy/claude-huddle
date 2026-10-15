import { atom, read, update } from 'claude-code'
import type { EngineInterface as Api, Register } from 'claude-code'

import type { Alert, CoordResult } from '../types'
import { type Lang, type Words, pickLang, words } from './i18n'
import {
  type Presence,
  assessAll,
  leadPrompt,
  nameOf,
  normalizeRemote,
  peerMessage,
  reasonOf,
  repoRelative,
  isHostId,
  sameAlerts,
  sessionLink,
  slashes,
} from './logic'

const alerts = atom({ plugin: 'huddle', key: 'alerts' } as const, [] as Alert[])
const snoozeUntil = atom({ plugin: 'huddle', key: 'snoozeUntil' } as const, 0)
const lastCoord = atom({ plugin: 'huddle', key: 'lastCoord' } as const, null as CoordResult | null)

const TICK_MS = 15_000
const SNOOZE_MS = 30 * 60_000
const STALE_MS = 24 * 60 * 60_000
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const HUMAN_ORIGINS = new Set<string>(['composer', 'bridge', 'sdk'])
// The desktop app's own read of a session: its sidebar title. Asked only when it runs without a permission prompt.
const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
const TITLE_EVERY = 4
const LEVEL_MARK = { 1: '◦', 2: '▲', 3: '■' } as const
const LEVEL_COLOR = { 1: 'subtle', 2: 'warning', 3: 'error' } as const

// The module's own variables: a reload starts them over and session.start fills them again.
let me: Presence | null = null
let dir = ''
let w: Words = words('en')
// Peer+level pairs already toasted, so an alert is raised once per escalation.
const toasted = new Set<string>()
let ticks = 0

/** Claude Code's `language` setting, then LC_ALL/LANG; English by default. */
async function detectLang($: Api): Promise<Lang> {
  const settings = (await $.settings.read().catch(() => ({}))) as { language?: unknown }
  const locale = (await $.env.get('LC_ALL').catch(() => null)) || (await $.env.get('LANG').catch(() => null)) || null
  return pickLang(undefined, settings.language, locale)
}

async function git($: Api, cwd: string, args: string[]) {
  const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 5000 })
  return r.exitCode === 0 ? r.stdout.trim() : ''
}

async function save($: Api) {
  if (!me) return
  me.lastSeen = await $.clock.now()
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
      const p = JSON.parse(text) as Presence
      if (p.v !== 1) continue
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

async function refresh($: Api) {
  if (!me) return
  if (ticks++ % TITLE_EVERY === 0) await refreshTitle($).catch(() => {})
  me.branch = (await git($, me.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) || me.branch
  await save($)
  const now = await $.clock.now()
  const next = assessAll(me, await readPeers($, now), now)
  const prev = await read($, alerts)
  if (!sameAlerts(prev, next)) await update($, alerts, () => next)

  const snoozed = (await read($, snoozeUntil)) > now
  for (const a of next) {
    const key = `${a.sessionId}:${a.level}`
    if (a.level < 3 || toasted.has(key) || snoozed) continue
    toasted.add(key)
    $.ui.toast(w.toastClash(me.repoName, reasonOf(w, a)))
  }
  $.ui.status(next.length ? w.status(next.length + 1, me.repoName) : undefined)
}

/** Sends the protocol to every live peer and asks this session's model to lead. Answers what the toast says. */
async function coordinate($: Api): Promise<string> {
  if (!me) return w.commandNotRepo
  const now = await $.clock.now()
  const current = assessAll(me, await readPeers($, now), now)
  if (current.length === 0) {
    $.ui.toast(w.toastNoPeers)
    return w.toastNoPeers
  }
  const sent: string[] = []
  const failed: string[] = []
  for (const a of current) {
    const r = await $.session
      .send({ to: { sessionId: a.sessionId }, text: peerMessage(w, me, a, now) })
      .catch(err => ({ isDelivered: false as const, reason: String(err) }))
    if (r.isDelivered) sent.push(a.sessionId)
    else failed.push(`${a.sessionId.slice(0, 8)}: ${r.reason}`)
  }
  await update($, lastCoord, () => ({ at: now, sent: sent.length, failed }))
  const told = failed.length ? w.toastPartial(sent.length, failed.length) : w.toastSent(sent.length)
  $.ui.toast(told)
  void $.prompt.submit({ text: leadPrompt(w, me, current, sent) })
  return told
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    w = words(await detectLang($))
    const cwd = await $.session.cwd()
    const toplevel = await git($, cwd, ['rev-parse', '--show-toplevel'])
    if (!toplevel) return started

    const commonDir = await git($, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const remote = await git($, cwd, ['config', '--get', 'remote.origin.url'])
    const repoKey = remote ? normalizeRemote(remote) : slashes(commonDir)
    const now = await $.clock.now()
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    dir = `${slashes(home)}/.claude/huddle/sessions`

    me = {
      v: 1,
      sessionId: await $.session.id(),
      cwd,
      toplevel: slashes(toplevel),
      repoKey,
      repoName: repoKey.split('/').filter(Boolean).at(-1)?.replace(/\.git$/, '') ?? toplevel,
      branch: await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      task: '',
      hostId: (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) || undefined,
      files: {},
      startedAt: now,
      lastSeen: now,
    }
    // A reload keeps the session: pick up what this session already recorded.
    try {
      const saved = JSON.parse(await $.fs.read(`${dir}/${me.sessionId}.json`)) as Presence
      me.task = saved.task
      me.title = saved.title
      me.files = saved.files
      me.startedAt = saved.startedAt
    } catch {
      // first start
    }

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

    await refresh($)
    $.clock.every(TICK_MS, () => void refresh($).catch(() => {}))
    return started
  })

  on('command.run', { command: 'huddle' }, async $ => ({ text: await coordinate($) }))

  on('prompt.submit', async ($, e, next) => {
    // The task is what a person asked: typed, sent from a phone or an SDK host; never a peer's or a plugin's text.
    if (me && !me.task && HUMAN_ORIGINS.has(e.origin.kind)) {
      me.task = e.text.replace(/\s+/g, ' ').trim().slice(0, 140)
      save($).catch(() => {})
    }
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
    const ran = await next(e)
    if (!me || !EDIT_TOOLS.has(e.tool) || ran.deny !== undefined || ran.isError) return ran
    // Recording never changes the tool's result: the edit already happened.
    try {
      const input = e as unknown as { file_path?: string; notebook_path?: string }
      const path = input.file_path ?? input.notebook_path
      const rel = path ? repoRelative(me.toplevel, path) : null
      if (rel) {
        me.files[rel] = await $.clock.now()
        refresh($).catch(() => {})
      }
    } catch {
      // the next tick still runs
    }
    return ran
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
      return r.isDelivered ? { result: w.delivered } : { deny: w.notDelivered(r.reason) }
    } catch (err) {
      return { deny: w.notDelivered(String(err)) }
    }
  })

  on('session.end', async ($, e, next) => {
    if (me) {
      me.ended = true
      await save($).catch(() => {})
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, alerts)
    const now = await $.clock.now()
    if (!me || e.props.hasSurvey || list.length === 0 || (await read($, snoozeUntil)) > now) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const top = list[0]!.level
    const done = await read($, lastCoord)
    const repo = me.repoName

    return (
      <Box flexDirection="column" marginTop={1}>
        {list.slice(0, 3).map(a => (
          <Box flexDirection="row" gap={1}>
            <Text color={LEVEL_COLOR[a.level]}>
              {LEVEL_MARK[a.level]} {a.level === 3 ? w.clash : w.otherAgent} {w.in} {repo} · {reasonOf(w, a)}
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
            {w.coordinate}
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
