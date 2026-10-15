import { expect, test } from 'claude-code/testing'

import { pickLang, words } from '../hooks/i18n'
import {
  type Presence,
  assess,
  assessAll,
  isHostId,
  leadPrompt,
  nameOf,
  normalizeRemote,
  peerMessage,
  repoRelative,
  sessionLink,
} from '../hooks/logic'

const EN = words('en')
const ES = words('es')

const NOW = 1_800_000_000_000

const session = (over: Partial<Presence>): Presence => ({
  v: 1,
  sessionId: 'aaa',
  cwd: '/r/app',
  toplevel: '/r/app',
  repoKey: 'github.com/acme/app',
  repoName: 'app',
  branch: 'main',
  task: 'fix the login',
  files: {},
  startedAt: NOW - 60_000,
  lastSeen: NOW - 1_000,
  ...over,
})

test('remote spellings collapse to one repo key', () => {
  expect(normalizeRemote('git@github.com:Acme/app.git')).toBe('github.com/acme/app')
  expect(normalizeRemote('https://github.com/Acme/app')).toBe('github.com/acme/app')
  expect(normalizeRemote('https://user@github.com/Acme/app.git/')).toBe('github.com/acme/app')
})

test('other repo, ended or stale sessions raise nothing', () => {
  const me = session({})
  expect(assess(me, session({ sessionId: 'b', repoKey: 'github.com/x/y' }), NOW)).toBe(null)
  expect(assess(me, session({ sessionId: 'b', ended: true }), NOW)).toBe(null)
  expect(assess(me, session({ sessionId: 'b', lastSeen: NOW - 120_000 }), NOW)).toBe(null)
  expect(assess(me, me, NOW)).toBe(null)
})

test('level 1: same repo in another worktree, disjoint files', () => {
  const me = session({ files: { 'src/a.ts': NOW } })
  const peer = session({ sessionId: 'b', toplevel: '/r/app-wt', files: { 'src/b.ts': NOW } })
  expect(assess(me, peer, NOW)?.level).toBe(1)
})

test('level 2: same checkout, disjoint files', () => {
  const me = session({ files: { 'src/a.ts': NOW } })
  const peer = session({ sessionId: 'b', files: { 'src/b.ts': NOW } })
  expect(assess(me, peer, NOW)?.level).toBe(2)
})

test('level 3: same file edited, even across worktrees', () => {
  const me = session({ files: { 'src/a.ts': NOW, 'src/c.ts': NOW } })
  const peer = session({ sessionId: 'b', toplevel: '/r/app-wt', files: { 'src/a.ts': NOW } })
  const alert = assess(me, peer, NOW)
  expect(alert?.level).toBe(3)
  expect(alert?.overlap).toEqual(['src/a.ts'])
})

test('level 3: both touch single-owner files', () => {
  const me = session({ files: { 'package.json': NOW } })
  const peer = session({ sessionId: 'b', toplevel: '/r/app-wt', files: { 'pnpm-lock.yaml': NOW } })
  expect(assess(me, peer, NOW)?.level).toBe(3)
})

test('edits older than the window no longer count as overlap', () => {
  const old = NOW - 5 * 60 * 60_000
  const me = session({ files: { 'src/a.ts': old } })
  const peer = session({ sessionId: 'b', toplevel: '/r/app-wt', files: { 'src/a.ts': NOW } })
  expect(assess(me, peer, NOW)?.level).toBe(1)
})

test('alerts sort with the strongest first', () => {
  const me = session({ files: { 'src/a.ts': NOW } })
  const list = assessAll(
    me,
    [
      session({ sessionId: 'b', toplevel: '/r/wt1' }),
      session({ sessionId: 'c', toplevel: '/r/wt2', files: { 'src/a.ts': NOW } }),
      session({ sessionId: 'd' }),
    ],
    NOW,
  )
  expect(list.map(a => a.level)).toEqual([3, 2, 1])
})

test('messages carry the address, the clash and the protocol', () => {
  const me = session({ files: { 'src/a.ts': NOW } })
  const alert = assess(me, session({ sessionId: 'b', files: { 'src/a.ts': NOW } }), NOW)!
  const toPeer = peerMessage(EN, me, alert, NOW)
  expect(toPeer).toContain('id aaa')
  expect(toPeer).toContain('src/a.ts')
  expect(toPeer).toContain('Protocol')
  expect(toPeer).toContain('Respect your original instruction')
  expect(leadPrompt(EN, me, [alert], [])).toContain('could not be delivered')
  expect(leadPrompt(EN, me, [alert], ['b'])).not.toContain('could not be delivered')
  expect(peerMessage(ES, me, alert, NOW)).toContain('Respeta tu instrucción original')
  expect(leadPrompt(ES, me, [alert], [])).toContain('no se le pudo entregar')
})

test('language follows the setting, then the locale, English by default', () => {
  expect(pickLang(undefined, 'Spanish', null)).toBe('es')
  expect(pickLang(undefined, 'español', 'en_US.UTF-8')).toBe('es')
  expect(pickLang(undefined, 'english', 'es_MX.UTF-8')).toBe('en')
  expect(pickLang(undefined, undefined, 'es_MX.UTF-8')).toBe('es')
  expect(pickLang(undefined, undefined, null)).toBe('en')
  expect(EN.reason('overlap', 2)).toBe('both edited 2 files')
  expect(ES.reason('checkout', 0)).toContain('misma copia')
})

test('files are matched relative to the repo, Windows paths included', () => {
  expect(repoRelative('/home/user/app', '/home/user/app/src/a.ts')).toBe('src/a.ts')
  expect(repoRelative('/home/user/app', '/home/user/app-other/a.ts')).toBe(null)
  expect(repoRelative('C:/code/app', 'C:\\code\\app\\src\\a.ts')).toBe('src/a.ts')
})

test('a peer is named by its sidebar title, else by what it was asked', () => {
  const me = session({})
  const titled = assess(me, session({ sessionId: 'b', title: 'Billing refactor', hostId: 'local_b' }), NOW)!
  expect(titled.title).toBe('Billing refactor')
  expect(titled.hostId).toBe('local_b')
  expect(nameOf(EN, titled)).toBe('«Billing refactor»')
  const untitled = assess(me, session({ sessionId: 'c', task: 'add SSO' }), NOW)!
  expect(untitled.hostId).toBe('')
  expect(nameOf(EN, untitled)).toBe('«add SSO»')
  expect(nameOf(ES, { task: '' })).toBe('(sin tarea declarada)')
  expect(leadPrompt(EN, me, [titled], ['b'])).toContain('«Billing refactor»')
  expect(peerMessage(EN, session({ title: 'Auth work' }), titled, NOW)).toContain('«Auth work»')
})

test('a desktop session opens by the app link, and only a well-formed id is ever opened', () => {
  expect(sessionLink('local_abc')).toBe('claude://claude.ai/epitaxy/local_abc')
  expect(isHostId('local_22fd1b9f-193e-4f32-a0d8-f90dada2e4b2')).toBe(true)
  expect(isHostId('x & calc')).toBe(false)
  expect(isHostId('a"b')).toBe(false)
  expect(assess(session({}), session({ sessionId: 'b', hostId: 'bad id&' }), NOW)!.hostId).toBe('')
})
