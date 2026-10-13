# axo-link

A Wispr Flow-style bar at the bottom of your screen that tells you when an
agent is waiting on you, so you stop polling tabs.

Agents run as local CLI processes. The pill watches them, says what each one
did, and lets you send the next instruction without opening a chat window —
by typing, or by holding a hotkey and talking. The same hotkey dictates into
any app.

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
| `waiting_kind` | `control_request` / trailing `?` | `approval_request` · `question` · `finished` |

Approvals happen mid-turn. With `--permission-prompt-tool stdio`, anything
`acceptEdits` won't auto-allow arrives on stdout as a `control_request`
(`can_use_tool`) and the CLI pauses until a `control_response` goes back down
stdin. Approve lets the same turn carry on; typing a reply instead denies it
with your words ("no, use git rm"). No MCP server, no second process.

### The hub

Every machine runs the app; every app dials out to one hub and keeps a
WebSocket open. Connectors report their agents, the hub merges them into one
roster, and instructions go back down the socket of whichever machine owns the
agent. Nothing dials in, so it works behind home and office routers. See
[docs/architecture.md](docs/architecture.md) for where this is going.

### Voice

| Hold | Does |
|---|---|
| `Ctrl` + `Win` | dictate: let go and the text is typed into whatever app has focus |
| `Ctrl` + `Win` + `Alt` | talk to axo, the secretary: "what did I miss?", "approve it", "I'm driving" |

Tap instead of holding to go hands-free; tap again to stop. Both chords are
Wispr's defaults and can be changed under Settings in the pill.

At the desk an agent finishing is a chime and an amber bar, and axo only
speaks when you hold the key. Switch to **away** (Settings, or tell axo you're
driving) and it says each update out loud as it happens.

Both voices are Gemini Live sessions (`gemini-3.5-transcribe-live` for
dictation, `gemini-3.8-live` for axo). The app never holds the Gemini key: it
asks the hub for a one-use token per session. axo acts through six tools —
`agents`, `reply`, `approve`, `deny`, `stop`, `set_mode` — and reads a command
back before approving it.

## Run

Needs Node 22+ and the `claude` CLI installed and logged in.

```bash
npm install
```

```bash
npm start
```

Click the bar to open the panel; `+` picks a folder and starts an agent in it.
Alone, the app hosts its own hub on `127.0.0.1:7777`.

**Voice** needs a Gemini API key where the hub runs. Windows (applies to
terminals opened afterwards):

```bash
setx GEMINI_API_KEY "your-key"
```

macOS (add the line to `~/.zshrc` to keep it):

```bash
export GEMINI_API_KEY="your-key"
```

**First run on a Mac** asks for three permissions in System Settings →
Privacy & Security, for the terminal you ran `npm start` from: **Microphone**,
**Input Monitoring** (global hotkeys) and **Accessibility** (typing the
dictation in). Grant them and restart the app. The chords there are
`Ctrl` + `Cmd` to dictate and `Ctrl` + `Cmd` + `Option` to talk to axo.

**No sound getting through?** Open Settings in the pill and speak: the green
bar under Microphone should move, and the line under it names the mic in use.
A "default" mic can be a virtual one — WO Mic, Krisp, a camera app — that
sends pure silence when its source isn't running; pick a real one from the
list. Each recording also logs a line like
`[voice] talk: 2.3s of audio, peak 41%`; a peak of 0–1% is silence. Still
silent on Windows: Settings → Privacy & security → Microphone → *Let desktop
apps access your microphone*. On a Mac: System Settings → Privacy & Security →
Microphone → your terminal app.

**More machines.** On the machine that hosts the hub, set a token and open
it to the network (`setx` values apply to new terminals):

```bash
setx AXO_TOKEN "pick-a-long-random-string"
```

```bash
setx AXO_HOST "0.0.0.0"
```

On every other machine, point at it with the same token:

```bash
setx AXO_HUB "ws://home-pc:7777"
```

`AXO_DEVICE` overrides the machine name shown in the pill. The hub refuses to
listen beyond localhost without `AXO_TOKEN`. `node hub.js` runs it standalone.

## Checks

```bash
npm test
```

Eighteen tests. Against a fake CLI: turn settling, the `did` tally,
`waiting_kind`, mid-turn approve/deny, cancelled prompts, crash vs. stop.
Against a real hub: one roster across machines, routing to the owning
machine, offline reported, wrong token shut out, voice tokens. The hotkey
machine: hold, tap for hands-free, Ctrl+Win → +Alt switch, other shortcuts
left alone, chord recording. axo's tools: right agent, nonsense refused.

```bash
node smoke.js
```

The live check: drives the real `claude` binary through two turns, the second
needing a permission prompt, and prints PASS if the prompt pauses the turn and
approving resumes it. Run this after `claude login` — the unit tests can't
catch the CLI changing its protocol out from under the parser.

## Files

| File | |
|---|---|
| `agent.js` | spawn, NDJSON parse, state machine, mid-turn approvals. Vendors are a plain object, not a class hierarchy |
| `hub.js` | the hub: merged roster, routing, token check, heartbeat |
| `link.js` | the app's one outbound socket: connector + pill, request/reply, redials forever |
| `keys.js` | global hold-to-talk hotkeys: the state machine, plus the OS keyboard hook |
| `voice.js` | the two Gemini Live sessions (dictation, axo) and axo's tools |
| `main.js` | Electron main: hosts the hub unless `AXO_HUB` is set, the click-through window, paste, settings, IPC |
| `pill.html` | the whole UI, one file: the bar, mic and speaker, panel, settings |
| `preload.js` | context bridge |

## Scope

In: one roster across machines, what-it-did briefs, the waiting tab, mid-turn
approve/deny, reply box, stop, dictation into any app, a voice secretary with
desk and away modes.

Deliberately out, with the trigger for adding each (order in
[docs/architecture.md](docs/architecture.md)):

- **Dictation cleanup** — Wispr strips "um"s and fixes grammar; this types the
  transcript verbatim. Add a text-model pass if raw dictation reads badly.
- **Cloud hub, sign-in, device pairing** — when someone other than you uses it.
  Today it's one shared token.
- **Hooks for sessions you started yourself** — when you want terminal and
  desktop-app Claude sessions in the roster too.

`--permission-mode acceptEdits` means agents edit files without asking;
everything else comes to the pill as an approval.

## Credits

The CLI protocol — flags, stdin message shape, and the `result`-settles-a-turn
behaviour — was worked out by reading
[OpenMausBot](https://github.com/milind-soni/OpenMausBot)'s
`server/drivers/claude.ts` (Apache-2.0), then verified against the shipping
`claude` binary's own schema.
