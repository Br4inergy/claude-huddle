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
▲ Another agent in acme-api · same working copy (no worktree of its own) · «Dependency bumps» · main
Coordinating is recommended.  [ Coordinate ]  [ Snooze 30 min ]
```

Each other session is shown by the name you see in your sidebar (or, until it has one, by the start of what it was asked). In the Claude desktop app, click that name to jump to the session.

Press **Coordinate** (or run `/huddle`) and:

1. Every other live session in the repo receives a short coordination protocol: who's asking, what they're doing, which files clash.
2. Your own session is asked to lead: collect their answers, propose one owner per disputed file and the order of work, and summarize the agreement for you.
3. The other sessions answer and keep working on what doesn't clash.

## Install

```
/plugin install huddle --marketplace Br4inergy/claude-huddle
```

Install it in every Claude Code where you run sessions. Huddle sees the sessions that have it.

## Levels

| Level | When | What you see |
| --- | --- | --- |
| 1 · info | Another session in the same repo, in another worktree or clone, on different files | Grey line, status bar count |
| 2 · attention | Another session in the **same working copy** (shared index, stash, installs) | Yellow line |
| 3 · clash | Both sessions edited the **same file** in the last 4 hours, or both touched single-owner files (lockfile, `package.json`, migrations, schema, generated code) | Red line, a toast, "Coordinating is recommended" |

The same repo is recognized across clones and worktrees by its `origin` remote (or, with no remote, its git directory).

## The protocol the agents follow

- Reply with their task, the files they edited and the files they plan to touch.
- One owner per disputed file. Whoever goes first finishes and commits first; the other updates before touching those files. Lockfiles, `package.json`, migrations, schema and generated files get a single owner.
- In a shared working copy, nobody runs `checkout`, `stash`, `reset` or installs dependencies without telling the other.
- **Each agent keeps to its original instruction.** If committing, pushing or publishing was already part of its task, it still does it, in the agreed order and carefully. If it wasn't, coordinating is no reason to start. Coordinating is never a reason to stop doing what it was asked.

## Tools the agents get

- `peers`: the other live sessions in this repo, with level, task, branch and the files in conflict.
- `send`: a message to one of them by session id.

## What it doesn't do (yet)

- It only sees Claude Code sessions with Huddle installed. Codex, other tools or a human editing by hand are invisible to it.
- Edits are tracked from Claude's file tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`). Files changed through shell commands don't count toward a clash.
- It doesn't lock files or block edits. It warns and gets the agents talking.
- Sessions on different machines don't see each other. The registry is local to your computer.
- Jumping to a session by clicking its name works in the Claude desktop app. In a terminal the name is shown, not linked.
- In the desktop app, a session reads its own sidebar title only where that read needs no permission prompt; otherwise the title arrives with your next prompt.

## Files

Each session keeps one small JSON file under `~/.claude/huddle/sessions/` (its id, the desktop app's id for it, its sidebar title, repo, working-copy path, branch, the first 140 characters of the first prompt you typed, and the repo-relative files it edited) and refreshes it every 15 seconds. A session gone for a day is emptied on the next check. Nothing leaves your machine except the messages Claude Code itself delivers between your own sessions.

## Language

English or Spanish, following Claude Code's `language` setting, then your locale. Messages to other agents go out in the sender's language.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/logic.ts` holds the pure parts (levels, messages) and is what the tests cover. `hooks/register.tsx` wires them into Claude Code.

## License

MIT © Br4inergy
