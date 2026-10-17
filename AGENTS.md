# AGENTS.md

Read this first in every session. `CLAUDE.md` imports it, so Claude Code and Codex read the same file.

## What axo-link is

A secretary for AI coding agents. A small always-on-top pill (Electron) shows every coding-agent session on the PC, says what each one did, and lets you answer or instruct them by typing or by voice (Gemini Live). A hub merges sessions from several machines; for now it runs locally, inside the app.

The design lives in [`docs/architecture.md`](docs/architecture.md). It's the source of truth: when a design decision changes, change it there. [`README.md`](README.md) covers setup and checks.

## Layout

```
agents/                  everything that runs, follows or drives a coding agent
  summary.js             how any session's turn is summed up (brief, tally, argText, kindOf)
  sessions.js            runs agents headless for the pill (spawned sessions), any agent
  claude/
    spawned.js           Claude, spawned: `claude -p` args + stream-json protocol
    spawned.test.js
    launched/            Claude, launched: `axo claude`, Claude in axo's own terminal
      launcher.js        pseudo-terminal, hook server, screen copy, safe typing
      launcher.test.js
    attached/            Claude, attached: desktop app, VS Code, plain `claude` (not built yet)
  codex/                 later, the same three kinds
cli/axo.js               the `axo` command; only picks the agent's launcher
shared/link.js           the one outbound socket to the hub
app/                     axo's Electron app: main.js, pill.html (the whole UI), voice.js, keys.js, focus.js
hub/hub.js               the backend: roster, routing, token check, Gemini tokens, clean-up, speech
scripts/                 smoke.js (live check against the real claude), pill-reel.js (renders the pill to video)
docs/architecture.md     the design
```

Note: `app/` is axo's own app. Code for the Claude or Codex desktop apps goes in `agents/<agent>/attached/`.

## The three kinds of session

The split is by **how axo is connected** to a session, because that's what decides the code. Where the session shows up on screen doesn't.

| Kind | What it is | How axo talks to it | Code |
|---|---|---|---|
| **spawned** | started from the pill's + button | runs the agent headless, JSON over stdin/stdout | `agents/<agent>/spawned.js`, run by `agents/sessions.js` |
| **launched** | `axo claude` in a terminal | axo *is* the terminal (node-pty); Claude's hooks report state | `agents/<agent>/launched/` |
| **attached** | anything axo didn't start: desktop app, VS Code, plain `claude` | watches: Claude's live session files and global hooks; can't type into it | `agents/<agent>/attached/` |

### Adding an agent
- **spawned:** `agents/<agent>/spawned.js` exports `{ cmd, args, write, answer, parse, turn }` (see Claude's), registered in `VENDORS` in `agents/sessions.js`.
- **launched:** `agents/<agent>/launched/launcher.js` exports `run(args)`, registered in `LAUNCHERS` in `cli/axo.js`.
- **attached:** `agents/<agent>/attached/`.

## Checks

- `npm test`: Node's built-in test runner; every test sits next to the file it checks. Must pass before a commit.
- `node scripts/smoke.js`: drives the real `claude` binary. It spends the user's Claude usage, so ask first.
- `npm start` runs the app. It needs `GEMINI_API_KEY` in `.env` (copy `.env.example`).

## How to work here

- **Verify against the real thing.** Claude Code and Codex change between versions. Before changing how a CLI's protocol or hooks are handled, check what the installed version actually does, then note the version in a comment (e.g. "claude 2.1.301: one result covers both").
- **Live checks with Claude** use `--model haiku`. When starting a test Claude from inside a Claude session, drop the inherited `CLAUDE_CODE_*` / `CLAUDECODE` environment variables first: a child that inherits them saves no history and writes no live session file.
- **Keep it small.** Plain CommonJS, the Node standard library first, no new dependency for what a few lines can do. No classes or abstractions without a second use. A deliberate shortcut gets a `ponytail:` comment naming its limit and the upgrade path.
- **Comments say why**, not what. Match the surrounding code's style and comment density.
- **New logic leaves one test** that fails without it.
- **Explain big changes before building them.** New features or architecture: lay out the plan and wait for the user's go-ahead.

## Git

- Branches: `type/short-name` (`feat/…`, `fix/…`, `refactor/…`), one per piece of work.
- Commit messages:
  - a conventional subject (`fix: …`);
  - then a body in sections saying what changed and why. The history is the project's record.
- No AI co-author lines and no "Generated with …" lines, in commits or PRs.
- Into `main` only through a GitHub PR, merged with a **merge commit** (not squash), so each commit message survives.
- Commit or push only when the user asks.

## Never

- **Never commit secrets.** The repo is public: no keys, tokens or private notes. `.env` stays git-ignored. Don't print the Gemini key.
- **Don't build on Claude's private session-to-session channel.** That's the named pipes and the `~/.claude/sessions/*.key` files. It's undocumented and can change in any release.
- **Never type into a terminal blindly.** The launcher refuses to type over half-typed text or a permission prompt, and says why. Keep it that way.
