# Huddle

**Two Claude Code sessions in the same repo, about to edit the same file? Huddle sees it first, and gets them to split the work with one button.**

## The problem

You run several Claude Code sessions at once. One is fixing auth, another is adding a feature, a third is "just cleaning up". They don't know about each other:

- Two agents edit the same file and one silently overwrites the other.
- Both bump `package.json` or the lockfile, or both write a migration, and the merge is a mess.
- Two sessions share one working copy and one runs `git stash` or `checkout` under the other's feet.
- You only find out at merge time, when it's expensive.

Huddle watches for that, tells you how bad it is, and when you press **Coordinate** the agents agree on who owns what before they collide.

## What it looks like

A band above the prompt, colored by how serious the overlap is:

```
■ Clash in acme-api · both edited 2 files (src/auth.ts, src/session.ts) · «SSO login» · feature/sso
▲ Another agent in acme-web · same working copy (no worktree of its own) · «Dependency bumps» · main
Coordinating is recommended.  [ Coordinate ]  [ Snooze 30 min ]
```

Each other session is shown by the name you see in your sidebar (or, until it has one, by the start of what it was asked), next to the repo the alert is about. In the Claude desktop app, click that name to jump to the session.

Press **Coordinate** (or run `/huddle`) and:

1. Every other live session in the shared repos receives a short coordination protocol: who's asking, what they're doing, which files clash, and who leads.
2. Your own session leads: it waits for their replies, then records one owner per disputed file and a 3-line summary with the `agree` tool, which reaches everyone. It gives you the summary.
3. The other sessions answer the leader and keep working on what doesn't clash.

Once a huddle is going, the band changes with it:

- **Everyone who shares a repo with you is in it**: one calm line instead of alerts, `✓ Huddle with 6 sessions · led by «Billing refactor» · 5/6 confirmed`. A session confirms the first time it sends a message after joining. If a member edits a file the agreement gave to another member, a second soft line says so: `▲ «Auth» edited src/auth.ts (owner «SSO login»)`.
- **A new session shows up, or one that isn't in it**: the usual alert rows for those sessions only, and the button reads **Add to huddle**. It sends the protocol only to them (a member that adds tells the leader, who takes the replies).

Owner warnings reach the agent while it works, not at the end of its turn: when a session edits (with a file tool or from the shell) a file another live member owns, that tool's result carries a note ("this file belongs to «B» in the agreement") and you get a toast, once per file. A huddle message that arrives while an agent is mid-turn is also copied into its next tool result, so a long run sees it within the turn.

## Install

```
/plugin install huddle --marketplace Br4inergy/claude-huddle
```

Install it in every Claude Code where you run sessions. Huddle sees the sessions that have it. (A session still on 0.2.x shows up for 0.3.0 sessions, but doesn't see them.)

## Levels

Judged per repo, over every repo two sessions share. A session works in its home repo (where it started) and in any other repo it edits a file in or enters from the shell (`cd`, `git -C`, `pushd`), for the next 4 hours. Each peer raises one alert, for the strongest repo it shares with you.

| Level | When | What you see |
| --- | --- | --- |
| 1 · info | Another session in the same repo, in another worktree or clone, on different files | Grey line, status bar count |
| 2 · attention | Another session in the **same working copy** (shared index, stash, installs) | Yellow line |
| 3 · clash | Both sessions edited the **same file** in the last 4 hours, or both touched single-owner files (lockfile, `package.json`, migrations, schema, generated code) | Red line, a toast, "Coordinating is recommended" |

So a session that starts in one repo and goes on to edit `~/code/api` clashes with the session that lives there. The same repo is recognized across clones and worktrees by its `origin` remote (or, with no remote, its git directory).

### Sessions of one family

In the Claude desktop app a session can start another one. Those two already coordinate through the app, so Huddle keeps out of it: a session and the one that started it (its mother) never alert each other and never get the protocol. Two sessions started by the same mother (sisters) alert only on level 3, and that alert also reaches the mother with one short note, so she can settle who owns the files. A dim line closes the band: `◦ started by «Mother» · 2 daughters`. The link comes from the app (`get_session`), so this works in the desktop app only; a session you move to top level is no longer a daughter. Sessions outside the family are unchanged.

**Idle sessions don't alert.** A session nobody has typed to and whose agent has made no tool call in the last 2 hours is left out of the band and out of the huddle's count, unless its files clash with yours.

**Shell edits count.** Around every `Bash` command Huddle compares `git status` (plus the size and modification time of up to 300 dirty files) in your home repo, the repos you entered recently and the directories the command names, at most 3 repos, and attributes what changed to this session. Entering a repo (`cd ~/code/api && git push`) is enough to show up in it. Files that merely leave the status (a commit, a revert) are not edits.

## The protocol the agents follow

- Reply to the leader (the protocol names its session id) with the `send` tool or SendMessage: their task, the files they edited and the files they plan to touch.
- One owner per disputed file. Whoever goes first finishes and commits first; the other updates before touching those files. Lockfiles, `package.json`, migrations, schema and generated files get a single owner.
- In a shared working copy, nobody runs `checkout`, `stash`, `reset` or installs dependencies without telling the other, and each commits only its own files with a pathspec (`git commit -- <files>`).
- **Each agent keeps to its original instruction.** If committing, pushing or publishing was already part of its task, it still does it, in the agreed order and carefully. If it wasn't, coordinating is no reason to start. Coordinating is never a reason to stop doing what it was asked.
- The leader closes with the `agree` tool, once: one owner per disputed file and a short summary, sent to every member.

## Tools the agents get

- `peers`: the other live sessions that share a repo with this one, with repo, level, task, branch and the files in conflict.
- `send`: a message to one of them by session id.
- `agree`: for the huddle leader only. `{ summary, owners: [{ repo?, path, sessionId }] }` records who owns which file (`repo` is a repo name or key, the leader's own repo by default) and sends the summary to every member.

## What it doesn't do (yet)

- It only sees Claude Code sessions with Huddle installed. Codex, other tools or a human editing by hand are invisible to it.
- Shell edits are inferred from `git status` around each command: a change that never shows as dirty (a `git pull`, a checkout, a file git ignores) isn't seen, and in a working copy shared by two sessions, a file the other one changes while your command runs is attributed to you unless the other session had already recorded it.
- It doesn't lock files or block edits. It warns and gets the agents talking.
- Sessions on different machines don't see each other. The registry is local to your computer.
- An agent that is busy and makes no tool call gets a huddle message at the end of its turn, like any other message: the mid-turn copy and the owner warnings ride on tool calls.
- Jumping to a session by clicking its name works in the Claude desktop app, also for a session that is not open in the window right now. In a terminal, and for a headless `claude -p` run started from a desktop session, the name is shown, not linked.
- In the desktop app, a session reads its own sidebar title only where that read needs no permission prompt; otherwise the title arrives with your next prompt.

## Files

Each session keeps one small JSON file under `~/.claude/huddle/sessions/` (a headless run, one with no terminal, phone, IDE or desktop window behind it, such as a `claude -p` that a status line, a mod, a script or an SDK app starts, writes none until it edits something in a repo: until then it is no risk to anyone, and it doesn't show up as a nameless peer): its id, the desktop app's id for it, its sidebar title, the first 140 characters of the first prompt you typed, its language, when it was last active, the huddle it is in, and for each repo it works in the name, working-copy path, branch and the repo-relative files it edited in the last 4 hours. A huddle leader's file also holds the members, the owners and the summary. It is refreshed every 15 seconds; each session writes only its own file and reads the others'. A session gone for a day is emptied on the next check. Nothing leaves your machine except the messages Claude Code itself delivers between your own sessions.

## Language

English or Spanish, following Claude Code's `language` setting; with none, the language of the first thing you type (Spanish when it has more Spanish than English markers), then your locale. Messages to other agents go out in the sender's language.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/logic.ts` holds the pure parts (levels, huddle state, the band, command parsing, messages) and is what the tests cover. `hooks/register.tsx` wires them into Claude Code.

## License

MIT © Br4inergy
