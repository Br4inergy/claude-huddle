import { expect, test } from 'claude-code/testing'

import { inferLang, pickLang, words } from '../hooks/i18n'
import {
  compactForMidTurn,
  repoNameOf,
  type Presence,
  type Snapshot,
  addMarker,
  assess,
  assessAll,
  bandState,
  diffSnapshots,
  dirsInCommand,
  familyOf,
  huddleMarker,
  isHostId,
  isSeenSession,
  leadPrompt,
  motherOf,
  nameOf,
  normalizeRemote,
  ownerKey,
  ownerOf,
  parentFromSession,
  parseAddMarker,
  parseHuddleMarker,
  parsePorcelain,
  peerMessage,
  reasonOf,
  repoRelative,
  sessionLink,
  shouldPublish,
  shouldRefreshTitle,
  sisterNotice,
  stripMarkers,
  taskFromPrompt,
  upgradePresence,
} from '../hooks/logic'

const EN = words('en')
const ES = words('es')

const NOW = 1_800_000_000_000

// A session in one repo; the flat fields are shorthand for its home repo's entry.
type Flat = Partial<Omit<Presence, 'v' | 'home' | 'repos'>> & {
  repoKey?: string
  repoName?: string
  toplevel?: string
  branch?: string
  files?: Record<string, number>
}

const session = (over: Flat = {}): Presence => {
  const { repoKey = 'github.com/acme/app', repoName = 'app', toplevel = '/r/app', branch = 'main', files = {}, ...rest } = over
  return {
    v: 2,
    sessionId: 'aaa',
    cwd: '/r/app',
    home: repoKey,
    repos: { [repoKey]: { repoKey, repoName, toplevel, branch, files, seenAt: NOW - 1_000 } },
    task: 'fix the login',
    startedAt: NOW - 60_000,
    lastSeen: NOW - 1_000,
    lastActiveAt: NOW - 1_000,
    ...rest,
  }
}

const OTHER = 'github.com/acme/other'
const HOUR = 60 * 60_000

/** The same session also working in a second repo. */
const visiting = (p: Presence, repoKey: string, over: Partial<Presence['repos'][string]> = {}): Presence => ({
  ...p,
  repos: {
    ...p.repos,
    [repoKey]: { repoKey, repoName: repoKey.split('/').at(-1)!, toplevel: `/r/${repoKey.split('/').at(-1)}`, branch: 'main', files: {}, seenAt: NOW - 1_000, ...over },
  },
})

const inHuddle = (p: Presence, over: Partial<NonNullable<Presence['huddle']>> = {}): Presence => ({
  ...p,
  huddle: { id: 'h1', leaderId: 'aaa', joinedAt: NOW - 5_000, ...over },
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

test('a 0.2.x presence (v1) is read as a session whose only repo is its home', () => {
  const v1 = {
    v: 1,
    sessionId: 'old',
    cwd: '/r/app',
    toplevel: '/r/app',
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    branch: 'dev',
    task: 'legacy',
    title: 'Old one',
    files: { 'src/a.ts': NOW },
    startedAt: NOW - 9_000,
    lastSeen: NOW - 2_000,
  }
  const p = upgradePresence(v1)!
  expect(p.v).toBe(2)
  expect(p.home).toBe('github.com/acme/app')
  expect(Object.keys(p.repos)).toEqual(['github.com/acme/app'])
  expect(p.repos['github.com/acme/app']).toEqual({
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    toplevel: '/r/app',
    branch: 'dev',
    files: { 'src/a.ts': NOW },
    seenAt: NOW - 2_000,
  })
  expect(p.lastActiveAt).toBe(NOW - 2_000)
  expect(p.title).toBe('Old one')
  // and it clashes like any other session
  expect(assess(session({ files: { 'src/a.ts': NOW } }), p, NOW)?.level).toBe(3)
  // a v2 file without lastActiveAt, and garbage
  expect(upgradePresence({ ...session({}), lastActiveAt: undefined })!.lastActiveAt).toBe(NOW - 1_000)
  expect(upgradePresence({ v: 3, sessionId: 'x' })).toBe(null)
  expect(upgradePresence(null)).toBe(null)
})

test('a session visiting a repo clashes with a session homed in it', () => {
  const visitor = visiting(session({ sessionId: 'aaa' }), OTHER, { toplevel: '/r/other', files: { 'lib/x.ts': NOW } })
  const resident = session({ sessionId: 'b', repoKey: OTHER, repoName: 'other', toplevel: '/r/other', files: { 'lib/x.ts': NOW } })
  const alert = assess(visitor, resident, NOW)!
  expect(alert.level).toBe(3)
  expect(alert.repoKey).toBe(OTHER)
  expect(alert.repoName).toBe('other')
  expect(alert.overlap).toEqual(['lib/x.ts'])
  // seen from the other side it is the same clash
  expect(assess(resident, visitor, NOW)?.repoKey).toBe(OTHER)
  // same repo, same working copy, no shared files: level 2; another copy: level 1
  expect(assess(visiting(session({}), OTHER, { toplevel: '/r/other' }), session({ sessionId: 'b', repoKey: OTHER, toplevel: '/r/other' }), NOW)?.level).toBe(2)
  expect(assess(visiting(session({}), OTHER, { toplevel: '/r/other' }), session({ sessionId: 'b', repoKey: OTHER, toplevel: '/r/other-wt' }), NOW)?.level).toBe(1)
  // a repo visited long ago no longer counts
  const gone = visiting(session({}), OTHER, { seenAt: NOW - 5 * HOUR })
  expect(assess(gone, resident, NOW)).toBe(null)
})

test('one alert per peer, for the strongest repo they share', () => {
  const me = visiting(session({ sessionId: 'aaa' }), OTHER, { toplevel: '/r/other', files: { 'lib/x.ts': NOW } })
  const peer = visiting(session({ sessionId: 'b', toplevel: '/r/app-wt' }), OTHER, { toplevel: '/r/other-wt', files: { 'lib/x.ts': NOW } })
  // the home repo is only level 1 (another copy); the visited one is a real clash
  const alert = assess(me, peer, NOW)!
  expect(alert.level).toBe(3)
  expect(alert.repoKey).toBe(OTHER)
  expect(assessAll(me, [peer], NOW).length).toBe(1)
  // equal strength: the session's home repo is named
  const calm = assess(visiting(session({}), OTHER, { toplevel: '/r/other' }), visiting(session({ sessionId: 'c', toplevel: '/r/app-wt' }), OTHER, { toplevel: '/r/other-wt' }), NOW)!
  expect(calm.level).toBe(1)
  expect(calm.repoKey).toBe('github.com/acme/app')
})

test('dirsInCommand finds cd, pushd and git -C, against the working directory', () => {
  const home = '/Users/bob'
  expect(dirsInCommand('cd ~/TimeKast/timekast-os && git push', '/r/app', home)).toEqual(['/Users/bob/TimeKast/timekast-os'])
  expect(dirsInCommand('git -C ../other status', '/r/app', home)).toEqual(['/r/other'])
  expect(dirsInCommand('pushd /opt/x; make; popd', '/r/app', home)).toEqual(['/opt/x'])
  expect(dirsInCommand('cd "my dir" && ls', '/r/app', home)).toEqual(['/r/app/my dir'])
  expect(dirsInCommand("cd 'a b/c'", '/r/app', home)).toEqual(['/r/app/a b/c'])
  // a chain of cds reads each one against the last
  expect(dirsInCommand('cd a && cd b && git -C ../c log', '/r', home)).toEqual(['/r/a', '/r/a/b', '/r/a/c'])
  expect(dirsInCommand('cd ~ && ls', '/r/app', home)).toEqual(['/Users/bob'])
  expect(dirsInCommand('cd $HOME/x && ls', '/r/app', home)).toEqual(['/Users/bob/x'])
  expect(dirsInCommand('FOO=1 git -c user.name=x -C /abs/repo commit -m x', '/r/app', home)).toEqual(['/abs/repo'])
  // nothing to resolve: no directory, a variable, a glob, a plain command
  expect(dirsInCommand('pnpm test', '/r/app', home)).toEqual([])
  expect(dirsInCommand('cd $WORKDIR && ls', '/r/app', home)).toEqual([])
  expect(dirsInCommand('cd src/* && ls', '/r/app', home)).toEqual([])
  expect(dirsInCommand('cd - && ls', '/r/app', home)).toEqual([])
  expect(dirsInCommand('echo "cd /nowhere"', '/r/app', home)).toEqual([])
  expect(dirsInCommand('cd /a/b/../c/./d', '/r/app', home)).toEqual(['/a/c/d'])
})

test('a snapshot diff names the files a command changed', () => {
  const before: Snapshot = {
    'a.ts': { status: ' M', sig: '1:10' },
    'b.ts': { status: ' M', sig: '1:20' },
    'gone.ts': { status: ' M', sig: '1:5' },
    'big.ts': { status: ' M' },
  }
  const after: Snapshot = {
    'a.ts': { status: ' M', sig: '1:10' }, // untouched
    'b.ts': { status: ' M', sig: '2:25' }, // edited again
    'new.ts': { status: '??', sig: '3:1' }, // appeared
    'big.ts': { status: 'MM' }, // status changed
  }
  expect(diffSnapshots(before, after)).toEqual(['b.ts', 'big.ts', 'new.ts'])
  // 'gone.ts' left the list (committed): not an edit
  expect(diffSnapshots(before, before)).toEqual([])
  expect(diffSnapshots({}, {})).toEqual([])
})

test('git status -z is read, renames included', () => {
  const out = [' M src/a.ts', '?? new file.ts', 'R  src/new.ts', 'src/old.ts', 'A  src/b.ts', ''].join('\0')
  expect(parsePorcelain(out)).toEqual({ 'src/a.ts': ' M', 'new file.ts': '??', 'src/new.ts': 'R ', 'src/b.ts': 'A ' })
  expect(Object.keys(parsePorcelain(out, 2)).length).toBe(2)
  expect(parsePorcelain('')).toEqual({})
})

test('the huddle marker round-trips, and so does the add marker', () => {
  const marker = huddleMarker('aaa11111-1800000000000', 'aaa-lead')
  expect(marker).toBe('[huddle:aaa11111-1800000000000 leader:aaa-lead]')
  expect(parseHuddleMarker(`some text\n${marker}\nmore`)).toEqual({ id: 'aaa11111-1800000000000', leaderId: 'aaa-lead' })
  expect(parseHuddleMarker('no marker here')).toBe(null)
  expect(parseHuddleMarker('[huddle:bad id leader:x]')).toBe(null)
  const add = addMarker('h1', ['b', 'c-2'])
  expect(add).toBe('[huddle-add:h1 b,c-2]')
  expect(parseAddMarker(`I added them\n${add}`)).toEqual({ id: 'h1', sessionIds: ['b', 'c-2'] })
  expect(parseAddMarker(marker)).toBe(null)
  expect(parseHuddleMarker(add)).toBe(null)
  expect(stripMarkers(`hello\n${marker}\nworld\n${add}`)).toBe('hello\nworld')
  // the protocol carries the marker and names the leader
  const me = session({ files: { 'src/a.ts': NOW } })
  const alert = assess(me, session({ sessionId: 'b', files: { 'src/a.ts': NOW } }), NOW)!
  const msg = peerMessage(EN, me, alert, NOW, { id: 'h1', leaderId: 'lead-9' })
  expect(msg).toContain('[huddle:h1 leader:lead-9]')
  expect(msg).toContain('sessionId lead-9')
  expect(msg).toContain('git commit -- <files>')
  expect(peerMessage(ES, me, alert, NOW, { id: 'h1', leaderId: 'lead-9' })).toContain('git commit -- <archivos>')
  expect(peerMessage(EN, me, alert, NOW)).not.toContain('[huddle:')
})

test('owners are looked up by repo and path', () => {
  const lead = { members: ['b'], owners: { [ownerKey('github.com/acme/app', 'src/a.ts')]: 'b' }, createdAt: NOW }
  expect(ownerOf(lead, 'github.com/acme/app', 'src/a.ts')).toBe('b')
  expect(ownerOf(lead, OTHER, 'src/a.ts')).toBe(undefined)
  expect(ownerOf(lead, 'github.com/acme/app', 'src/z.ts')).toBe(undefined)
  expect(ownerOf(undefined, 'github.com/acme/app', 'src/a.ts')).toBe(undefined)
})

const leaderMe = (over: Partial<NonNullable<Presence['huddle']>> = {}, flat: Flat = {}) =>
  inHuddle(session({ sessionId: 'aaa', ...flat }), {
    lead: { members: ['b', 'c'], owners: {}, createdAt: NOW - 9_000 },
    ...over,
  })
const member = (id: string, ack: boolean, flat: Flat = {}) =>
  inHuddle(session({ sessionId: id, toplevel: `/r/wt-${id}`, title: `T-${id}`, ...flat }), ack ? { ackAt: NOW - 1_000 } : {})

test('the band: nothing, alerts, or one calm line', () => {
  // nobody else
  expect(bandState(session({}), [], NOW)).toEqual({ kind: 'none' })
  // peers in other repos, ended ones
  expect(bandState(session({}), [session({ sessionId: 'b', repoKey: OTHER })], NOW)).toEqual({ kind: 'none' })
  // no huddle yet: alert rows, offering to coordinate
  const plain = bandState(session({}), [session({ sessionId: 'b', toplevel: '/r/wt' })], NOW)
  expect(plain.kind).toBe('alert')
  if (plain.kind === 'alert') {
    expect(plain.hasHuddle).toBe(false)
    expect(plain.alerts.map(a => a.sessionId)).toEqual(['b'])
  }
  // everyone live is in my huddle: one line, with the count and the confirmations
  const calm = bandState(leaderMe(), [member('b', true), member('c', false)], NOW)
  expect(calm.kind).toBe('huddle')
  if (calm.kind === 'huddle') {
    expect(calm.size).toBe(3)
    expect(calm.confirmed).toBe(2) // the leader and b
    expect(calm.leaderIsMe).toBe(true)
    expect(calm.conflicts).toEqual([])
  }
  // seen by a member: the leader is named, its own confirmation counts
  const asMember = bandState(member('b', true), [leaderMe({ lead: { members: ['b', 'c'], owners: {}, createdAt: NOW - 9_000 } }, { title: 'Boss' }), member('c', true)], NOW)
  expect(asMember.kind).toBe('huddle')
  if (asMember.kind === 'huddle') {
    expect(asMember.leader.title).toBe('Boss')
    expect(asMember.leaderIsMe).toBe(false)
    expect(asMember.size).toBe(3)
    expect(asMember.confirmed).toBe(3)
  }
})

test('the band with a live huddle and a session outside it', () => {
  const outsider = session({ sessionId: 'd', toplevel: '/r/wt-d', title: 'Newcomer' })
  const state = bandState(leaderMe(), [member('b', true), member('c', true), outsider], NOW)
  expect(state.kind).toBe('alert')
  if (state.kind === 'alert') {
    expect(state.hasHuddle).toBe(true)
    expect(state.alerts.map(a => a.sessionId)).toEqual(['d'])
  }
  // a huddle whose leader is gone and nobody else was active in 4 hours is not live: plain alerts again
  const deadLeader = inHuddle(session({ sessionId: 'b' }), { leaderId: 'aaa' })
  const stale = bandState(deadLeader, [session({ sessionId: 'd', toplevel: '/r/wt-d' })], NOW)
  expect(stale.kind === 'alert' && stale.hasHuddle).toBe(false)
})

test('idle sessions do not alert, unless their files clash', () => {
  const idle = NOW - 3 * HOUR
  const quiet = session({ sessionId: 'b', toplevel: '/r/wt', lastActiveAt: idle })
  expect(assess(session({}), quiet, NOW)).toBe(null)
  expect(bandState(session({}), [quiet], NOW)).toEqual({ kind: 'none' })
  // level 3 from uncommitted shared files keeps it
  const clash = session({ sessionId: 'b', toplevel: '/r/wt', lastActiveAt: idle, files: { 'src/a.ts': NOW - HOUR } })
  const me = session({ files: { 'src/a.ts': NOW - HOUR } })
  expect(assess(me, clash, NOW)?.level).toBe(3)
  expect(bandState(me, [clash], NOW).kind).toBe('alert')
  // a session idle for under 2 hours still counts
  expect(assess(session({}), session({ sessionId: 'b', toplevel: '/r/wt', lastActiveAt: NOW - HOUR }), NOW)?.level).toBe(1)
  // and an idle member is out of the calm line's count
  const calm = bandState(leaderMe(), [member('b', true), member('c', true, { lastActiveAt: idle })], NOW)
  expect(calm.kind === 'huddle' && calm.size).toBe(2)
})

test('the band shows a member that edited a file the agreement gave to another', () => {
  const key = ownerKey('github.com/acme/app', 'src/a.ts')
  const lead = { members: ['b', 'c'], owners: { [key]: 'b' }, createdAt: NOW - 9_000, agreedAt: NOW - 8_000 }
  const editor = leaderMe({ lead }, { title: 'Editor', files: { 'src/a.ts': NOW - 1_000 } })
  const owner = member('b', true, { title: 'Owner' })
  const state = bandState(editor, [owner, member('c', true)], NOW)
  expect(state.kind).toBe('huddle')
  if (state.kind === 'huddle') {
    expect(state.conflicts.length).toBe(1)
    expect(state.conflicts[0]!.file).toBe('src/a.ts')
    expect(nameOf(EN, state.conflicts[0]!.editor)).toBe('«Editor»')
    expect(nameOf(EN, state.conflicts[0]!.owner)).toBe('«Owner»')
    expect(EN.editedOwned('«Editor»', 'src/a.ts', '«Owner»')).toBe('«Editor» edited src/a.ts (owner «Owner»)')
  }
  // the owner editing its own file, or an edit from before the agreement, is no conflict
  const own = bandState(editor, [member('b', true, { files: { 'src/a.ts': NOW - 1_000 } }), member('c', true)], NOW)
  const before = bandState(leaderMe({ lead }, { files: { 'src/a.ts': NOW - 20_000 } }), [owner, member('c', true)], NOW)
  expect(own.kind === 'huddle' && own.conflicts.length).toBe(1) // only the leader's edit
  expect(before.kind === 'huddle' && before.conflicts.length).toBe(0)
})

test('the language is inferred from what the person writes', () => {
  expect(inferLang('arregla el login de la aplicación, ¿puedes?')).toBe('es')
  expect(inferLang('también necesito que esté listo para mañana')).toBe('es')
  expect(inferLang('please fix the login and add tests for this')).toBe('en')
  expect(inferLang('ok')).toBe(null)
  expect(inferLang('')).toBe(null)
  // the setting still wins, then the prompts, then the locale
  expect(pickLang(undefined, 'English', 'es_MX.UTF-8', 'es')).toBe('en')
  expect(pickLang(undefined, undefined, 'en_US.UTF-8', 'es')).toBe('es')
  expect(pickLang(undefined, undefined, 'es_MX.UTF-8', null)).toBe('es')
  expect(pickLang(undefined, undefined, null, null)).toBe('en')
})

test('a prompt from the parent session is never the task', () => {
  expect(taskFromPrompt('Background (from the session that started this one): the repo is X')).toBe('')
  expect(taskFromPrompt('  Background (from the session that started this one)\nmore')).toBe('')
  expect(taskFromPrompt('  fix   the\n login ')).toBe('fix the login')
  expect(taskFromPrompt('x'.repeat(300)).length).toBe(140)
  expect(taskFromPrompt('')).toBe('')
})

test('titles are read every tick at first, then every fourth', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7].every(shouldRefreshTitle)).toBe(true)
  expect([9, 10, 11, 13, 14, 15].some(shouldRefreshTitle)).toBe(false)
  expect([8, 12, 16].every(shouldRefreshTitle)).toBe(true)
})

test('every new text exists in both languages', () => {
  for (const x of [EN, ES]) {
    expect(x.addToHuddle.length > 0).toBe(true)
    expect(x.huddleWith(6)).toContain('6')
    expect(x.confirmed(5, 6)).toContain('5/6')
    expect(x.statusHuddle(3)).toContain('3')
    expect(x.ownerConflict('src/a.ts', '«B»')).toContain('src/a.ts')
    expect(x.toastOwner('src/a.ts', '«B»')).toContain('«B»')
    expect(x.midTurnNote('«A»', 'use the new API')).toContain('use the new API')
    expect(x.agreeMessage({ summary: 'S', owners: ['- app/a.ts → «B»'], marker: '[huddle:h1 leader:x]' })).toContain('[huddle:h1 leader:x]')
    expect(x.addedNotice('«C»', '[huddle-add:h1 c]')).toContain('[huddle-add:h1 c]')
    expect(x.leadClose).toContain('agree')
    expect(x.leadAdded('«C»')).toContain('agree')
    expect(x.agreeDone(2, 1)).toContain('1')
    expect(x.agreeBadRepo('zzz')).toContain('zzz')
    expect([x.ledBy, x.ledByYou, x.aMember, x.agreeNotLeader, x.agreeNoHuddle, x.agreeBadInput, x.toolAgree, x.toastAllIn].every(t => t.length > 0)).toBe(true)
  }
  expect(EN.huddleWith(6)).toBe('Huddle with 6 sessions')
  expect(ES.huddleWith(6)).toBe('En huddle con 6 sesiones')
  expect(EN.confirmed(5, 6)).toBe('5/6 confirmed')
  expect(ES.confirmed(5, 6)).toBe('5/6 confirmaron')
  expect(ES.editedOwned('«A»', 'x.ts', '«B»')).toBe('«A» editó x.ts (dueño «B»)')
  const lead = leadPrompt(EN, session({}), [assess(session({}), session({ sessionId: 'b' }), NOW)!], ['b'])
  expect(lead).toContain('do not message them until they reply')
  expect(lead).toContain('agree')
  expect(leadPrompt(ES, session({}), [assess(session({}), session({ sessionId: 'b' }), NOW)!], ['b'])).toContain('no les escribas hasta que contesten')
})

test('a repo without a remote is named by its folder', () => {
  expect(repoNameOf('github.com/acme/app', '/home/user/app-wt')).toBe('app')
  expect(repoNameOf('/home/user/tools/.git', '/home/user/tools')).toBe('tools')
})

test('a busy agent gets the clash and how to answer, not the whole protocol', () => {
  const me = session({ files: { 'src/a.ts': NOW } })
  const alert = assess(me, session({ sessionId: 'b', files: { 'src/a.ts': NOW } }), NOW)!
  const full = peerMessage(EN, me, alert, NOW, { id: 'h1', leaderId: 'aaa' })
  const short = compactForMidTurn(full)
  expect(short).toContain('src/a.ts')
  expect(short).toContain('1. ')
  expect(short).not.toContain('2. ')
  expect(short).not.toContain('[huddle:h1')
  expect(compactForMidTurn('x'.repeat(5000)).length).toBe(1500)
})

// ---- Sessions of one family (the desktop app's start_session) ----

const kin = (id: string, host: string, parent?: string, flat: Flat = {}): Presence =>
  session({ sessionId: id, hostId: host, parentHostId: parent, toplevel: `/r/wt-${id}`, ...flat })

test('familyOf: mother, daughter, sister, unrelated, unknown', () => {
  const mom = kin('m', 'local_m')
  const kid = kin('k1', 'local_k1', 'local_m')
  const sis = kin('k2', 'local_k2', 'local_m')
  expect(familyOf(kid, mom)).toBe('mother')
  expect(familyOf(mom, kid)).toBe('daughter')
  expect(familyOf(kid, sis)).toBe('sister')
  expect(familyOf(mom, kin('x', 'local_x'))).toBe(null)
  expect(familyOf(kid, kin('y', 'local_y', 'local_other'))).toBe(null)
  // no ids known: no family
  expect(familyOf(session({ sessionId: 'a' }), session({ sessionId: 'b' }))).toBe(null)
  expect(familyOf(kin('a', 'local_a'), kin('b', 'local_b'))).toBe(null)
  expect(familyOf(session({ sessionId: 'a', parentHostId: 'local_m' }), session({ sessionId: 'b' }))).toBe(null)
})

test('mother and daughter never alert, at any level', () => {
  const mom = kin('m', 'local_m', undefined, { files: { 'src/a.ts': NOW - 1_000 } })
  const kid = kin('k1', 'local_k1', 'local_m', { files: { 'src/a.ts': NOW - 1_000 } })
  expect(assess(kid, mom, NOW)).toBe(null) // level 3 files
  expect(assess(mom, kid, NOW)).toBe(null)
  const sameCopy = kin('k1', 'local_k1', 'local_m', { toplevel: '/r/app' })
  expect(assess(session({ sessionId: 'm', hostId: 'local_m' }), sameCopy, NOW)).toBe(null) // level 2
  const otherCopy = kin('k1', 'local_k1', 'local_m')
  expect(assess(session({ sessionId: 'm', hostId: 'local_m' }), otherCopy, NOW)).toBe(null) // level 1
  expect(assessAll(kid, [mom], NOW)).toEqual([])
})

test('sisters alert only at level 3, with family set', () => {
  const me = kin('k1', 'local_k1', 'local_m')
  expect(assess(me, kin('k2', 'local_k2', 'local_m', { toplevel: '/r/app' }), NOW)).toBe(null) // level 2
  expect(assess(me, kin('k2', 'local_k2', 'local_m'), NOW)).toBe(null) // level 1
  const clashing = kin('k2', 'local_k2', 'local_m', { files: { 'src/a.ts': NOW - 1_000 } })
  const a = assess(kin('k1', 'local_k1', 'local_m', { files: { 'src/a.ts': NOW - 1_000 } }), clashing, NOW)
  expect(a?.level).toBe(3)
  expect(a?.family).toBe('sister')
  expect(reasonOf(EN, a!)).toContain('sister session')
  expect(reasonOf(ES, a!)).toContain('sesión hermana')
  // outside the family nothing changes
  const stranger = assess(session({ files: { 'src/a.ts': NOW - 1_000 } }), session({ sessionId: 'b', files: { 'src/a.ts': NOW - 1_000 } }), NOW)
  expect(stranger?.family).toBe(undefined)
})

test('the band: family line, the family kind, and family kept out of the huddle', () => {
  const kid = kin('k1', 'local_k1', 'local_m', { title: 'Kid' })
  const mom = kin('m', 'local_m', undefined, { title: 'Mom' })
  const sis = kin('k2', 'local_k2', 'local_m')
  // only family around: the new kind, with the mother named and no daughters
  expect(bandState(kid, [mom], NOW)).toEqual({ kind: 'family', family: { mother: { title: 'Mom', task: 'fix the login', hostId: 'local_m' }, daughters: 0 } })
  // the mother sees her two daughters
  const two = bandState(mom, [kid, sis], NOW)
  expect(two).toEqual({ kind: 'family', family: { daughters: 2 } })
  // an ended or stale family member is not shown
  expect(bandState(mom, [{ ...kid, ended: true }], NOW)).toEqual({ kind: 'none' })
  // family next to an outsider: the alert is for the outsider alone, with the family line
  const outsider = session({ sessionId: 'z', toplevel: '/r/wt-z' })
  const mixed = bandState(kid, [mom, outsider], NOW)
  expect(mixed.kind).toBe('alert')
  if (mixed.kind === 'alert') {
    expect(mixed.alerts.map(a => a.sessionId)).toEqual(['z'])
    expect(mixed.family?.mother?.title).toBe('Mom')
  }
  // a mother whose marker reached her is not a member of the calm line
  const lead = inHuddle(kin('k1', 'local_k1', 'local_m'), { leaderId: 'k1', lead: { members: ['k2', 'm'], owners: {}, createdAt: NOW - 9_000 } })
  const calm = bandState(lead, [inHuddle(sis, { leaderId: 'k1' }), inHuddle(mom, { leaderId: 'k1' })], NOW)
  expect(calm.kind === 'family').toBe(true) // sis is level 1: no alerts, so only the family
  const sisClash = kin('k2', 'local_k2', 'local_m', { files: { 'src/a.ts': NOW - 1_000 } })
  const leadClash = inHuddle(kin('k1', 'local_k1', 'local_m', { files: { 'src/a.ts': NOW - 1_000 } }), { leaderId: 'k1', lead: { members: ['k2', 'm'], owners: {}, createdAt: NOW - 9_000 } })
  const huddle = bandState(leadClash, [inHuddle(sisClash, { leaderId: 'k1' }), inHuddle(mom, { leaderId: 'k1' })], NOW)
  expect(huddle.kind).toBe('huddle')
  if (huddle.kind === 'huddle') {
    expect(huddle.size).toBe(2) // me and my sister, not the mother
    expect(huddle.family?.mother?.title).toBe('Mom')
  }
})

test('parentFromSession reads get_session; a detached parent is ignored', () => {
  expect(parentFromSession({ title: 'x', parentSessionId: 'local_m' })).toBe('local_m')
  expect(parentFromSession({ parentSessionId: 'local_m', detached: true })).toBe(undefined)
  expect(parentFromSession({ parentSessionId: 'local_m', detached: false })).toBe('local_m')
  expect(parentFromSession({ title: 'x' })).toBe(undefined)
  expect(parentFromSession({ parentSessionId: '../etc; rm' })).toBe(undefined)
  expect(parentFromSession({ parentSessionId: 42 })).toBe(undefined)
  expect(parentFromSession(null)).toBe(undefined)
})

test('the mother is found live, and told once what her daughters clash on', () => {
  const mom = kin('m', 'local_m')
  const me = kin('k1', 'local_k1', 'local_m', { title: 'One' })
  expect(motherOf(me, [mom], NOW)?.sessionId).toBe('m')
  expect(motherOf(me, [{ ...mom, lastSeen: NOW - 5 * 60_000 }], NOW)).toBe(undefined)
  const clash = assess(
    kin('k1', 'local_k1', 'local_m', { title: 'One', files: { 'src/a.ts': NOW - 1_000, 'src/b.ts': NOW - 1_000 } }),
    kin('k2', 'local_k2', 'local_m', { title: 'Two', files: { 'src/a.ts': NOW - 1_000, 'src/b.ts': NOW - 1_000 } }),
    NOW,
  )!
  const text = sisterNotice(EN, me, [clash])
  expect(text).toContain('«One»')
  expect(text).toContain('«Two»')
  expect(text).toContain('src/a.ts, src/b.ts')
})

test('family texts exist in English and Spanish', () => {
  expect(EN.familyMother('«Boss»')).toBe('started by «Boss»')
  expect(ES.familyMother('«Jefa»')).toBe('la inició «Jefa»')
  expect(EN.familyDaughters(2)).toBe('2 daughters')
  expect(EN.familyDaughters(1)).toBe('1 daughter')
  expect(ES.familyDaughters(2)).toBe('2 hijas')
  expect(ES.familyDaughters(1)).toBe('1 hija')
  expect(EN.sisterClashToMother('«A»', '«B»', 'x.ts')).toContain('x.ts')
  expect(ES.sisterClashToMother('«A»', '«B»', 'x.ts')).toContain('x.ts')
  expect(EN.sisterSuffix).not.toBe(ES.sisterSuffix)
})

test('a desktop session not open in the window is still seen; a claude -p helper is not', () => {
  // On a surface: seen.
  expect(isSeenSession(false, [{ kind: 'terminal' }], [])).toBe(true)
  // Desktop-hosted with no surface for hours: its mcp__ccd_* tools say so.
  expect(isSeenSession(false, [], ['Bash', 'mcp__ccd_session__start_session'])).toBe(true)
  // A headless child: inherits the env, not the tools.
  expect(isSeenSession(false, [], ['Bash', 'Read', 'mcp__huddle__peers'])).toBe(false)
  expect(isSeenSession(false, [], [])).toBe(false)
  // Sticky: a desktop that detaches does not take the id back.
  expect(isSeenSession(true, [], [])).toBe(true)
  // Only the prefix counts, not a lookalike.
  expect(isSeenSession(false, [], ['mcp__ccdx_tool', 'ccd_session'])).toBe(false)
})

test('a run no one sees writes no presence until it edits something', () => {
  const clean = { repos: { r: { repoKey: 'r', repoName: 'r', toplevel: '/r', branch: 'main', files: {} } } }
  const edited = { repos: { r: { ...clean.repos.r, files: { 'src/a.ts': NOW } } } }
  expect(shouldPublish(true, clean)).toBe(true)
  expect(shouldPublish(false, clean)).toBe(false)
  expect(shouldPublish(false, edited)).toBe(true)
  expect(shouldPublish(false, { repos: {} })).toBe(false)
})
