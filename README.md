# axo-link

An always-on-top pill that tells you when an agent is waiting on you, so you
stop polling tabs.

Agents run as local CLI processes. The pill watches them, says what each one
did, and lets you send the next instruction without opening a chat window.

## How it works

One `claude` process per session, spawned with `--input-format stream-json`.
That flag is the whole trick: **the process stays alive across turns**. Turns
go in on stdin, events come back on stdout as NDJSON, and the CLI settles each
turn with a `result` line.

```
{"type":"system","subtype":"init","session_id":"…","model":"…"}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"},…]}}
{"type":"result","is_error":false,"result":"…","permission_denials":[…]}
```

That `result` line *is* the "agent finished" signal. Nothing polls, nothing
scrapes a DOM, nothing guesses — which is why there is no vendor watcher here
and no precision/recall tradeoff to tune.

Three things are derived from it:

| Field | From | Used for |
|---|---|---|
| `did` | `tool_use` blocks, tallied | "Read, Edit ×3, Bash ×2" |
| `summary` | first two sentences of `result` | what gets spoken/shown |
| `waiting_kind` | `permission_denials` / trailing `?` | `approval_request` · `question` · `finished` |

`result.permission_denials` is the CLI's own authoritative record of what it
was blocked from doing, so the approval tab needs no MCP server, no socket, and
no second process.

## Run

Needs Node 22+ and the `claude` CLI installed and logged in.

```bash
npm install
```

```bash
npm start
```

Hit `+` to pick a folder and start an agent in it. Click the pill to expand.

## Checks

```bash
npm test
```

Seven tests against a fake CLI — turn settling, the `did` tally, `waiting_kind`
classification, approve-continues-the-session, crash surfacing.

```bash
node smoke.js
```

The live check: drives the real `claude` binary through two turns and prints
PASS if the session settles and survives. Run this after `claude login` — the
unit tests can't catch the CLI changing its protocol out from under the parser.

## Files

| File | |
|---|---|
| `agent.js` | spawn, NDJSON parse, state machine. Vendors are a plain object — `codex` and `grok` are two more entries, not a class hierarchy |
| `main.js` | Electron main: window, notifications, IPC |
| `pill.html` | the whole UI, one file |
| `preload.js` | context bridge |

## Scope

In: session roster, turn-end notifications, what-it-did briefs, the waiting
tab, post-hoc approve/deny, reply box.

Deliberately out, with the trigger for adding each:

- **Voice** — add when typing into the pill gets old. The `summary` + `did`
  pairing is already shaped to be read aloud.
- **Blocking approvals** — today the agent hits a permission wall, *stops*, and
  reports; Approve sends "go ahead" as the next turn. The real-time version is
  `--permission-prompt-tool` pointed at an MCP `approve` tool returning
  `{"behavior":"allow"}`, which pauses the CLI mid-turn until you answer. Worth
  the ~120 lines only once voice makes "ask me out loud" the main interaction.
- **Router/WebSocket split** — add when the phone client is real. IPC now; the
  intents (`reply`/`approve`/`deny`) already have the same shape either way.

`--permission-mode acceptEdits` means agents edit files without asking, and a
headless run silently *denies* anything it can't auto-accept. That's what the
approval tab surfaces.

## Credits

The CLI protocol — flags, stdin message shape, and the `result`-settles-a-turn
behaviour — was worked out by reading
[OpenMausBot](https://github.com/milind-soni/OpenMausBot)'s
`server/drivers/claude.ts` (Apache-2.0), then verified against the shipping
`claude` binary's own schema.
