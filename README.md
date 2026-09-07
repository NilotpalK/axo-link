# axo-link

An always-on-top pill that **tells you out loud** when an agent is waiting on
you, and lets you answer by voice — so you stop polling tabs.

Agents run as local CLI processes. The pill watches them, says what each one
did, and takes your next instruction without you opening a chat window.

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
| `summary` | first two sentences of `result` | what gets spoken and shown |
| `waiting_kind` | `permission_denials` / trailing `?` | `approval_request` · `question` · `finished` |

`result.permission_denials` is the CLI's own authoritative record of what it
was blocked from doing, so the approval tab needs no MCP server, no socket, and
no second process.

## Voice

**It talks.** When a session settles, `speak.js` reads the line out through
macOS `say` — no key, no network, no latency:

```
"axo-link needs approval. Ran Edit 2 times, Bash.
 I could not delete the stale build output without permission.
 Wants to run Bash rm -rf ./build."
```

The queue is serial, so two agents finishing together take turns instead of
talking over each other.

**You talk back.** `F13` opens the mic (and cuts off whatever is speaking).
It closes itself after ~1.2s of trailing silence, transcribes through OpenAI
(`gpt-4o-mini-transcribe`), and the text becomes the next turn.

**There is no intent parser, on purpose.** `approve()` and `deny()` were always
just `send()` with canned English, and the thing receiving it is an LLM. So
"yeah go ahead" and "no, use redis instead" are both simply the next turn —
no command grammar, no classifier, no routing pass.

### Which session hears you

Resolved once, when the mic opens, so it can't shift mid-sentence:

1. whatever just spoke — you are answering what you heard
2. the only thing waiting, if there is exactly one
3. whatever is selected in the pill

The pill shows the target while listening (`→ axo-link`), so it is never a guess.

## Run

Needs Node 22+ and the `claude` CLI installed and logged in.

```bash
npm install
npm run dev          # vite + electron, hot reload
npm start            # build the renderer, then run
```

Hit `+` to pick a folder and start an agent in it. Click the pill to expand.

Voice replies need an OpenAI key. Either export it:

```bash
export OPENAI_API_KEY=sk-...
```

or press `F13` once and paste it into the prompt — it is stored encrypted by
your OS keychain via Electron's `safeStorage`, not in a dotfile.

## Layer hub (optional)

The pill can also talk to a remote Layer hub so
wearer replies and agent whispers share one room stream — without replacing the
local CLI watcher.

Default hub: `https://temporary-sonic-silver-10hrsnu.vercel.app`

| Direction | Endpoint | When |
|---|---|---|
| Wearer → hub | `POST /api/turn` `{ text }` | Typed or spoken reply (also still goes to the local CLI when one is selected) |
| Hub → pill | `GET /api/room/stream` (SSE) | `agent-whisper` events surface as waiting rows and are spoken |
| Agent → hub | `POST /api/whispers` `{ agent, text, urgent? }` | Available on the helper; not wired from the CLI yet |

```bash
export LAYER_HUB_URL=https://temporary-sonic-silver-10hrsnu.vercel.app   # default
export LAYER_HUB_URL=                                                     # disable
```

`src/helpers/layer-hub.js` owns the client. Whispers map lightly onto pill
fields: `summary = text`, `waiting_kind = question` if urgent/interrupt else
`finished`, `did` left empty. Staff-inbox / spawn-agent / gemini-token are left
alone for now.

## Checks

```bash
npm test
```

tests: turn settling, the `did` tally, `waiting_kind` classification,
approve-continues-the-session, crash surfacing, the spoken line, speak-queue
ordering, the silence gate, and Layer hub whisper→pill mapping.

```bash
node smoke.js         # drives the real `claude` binary through two turns
node smoke-voice.js   # says a line, then round-trips `say` → webm → OpenAI → text
```

The live checks exist because unit tests can't catch the CLI changing its
protocol, `say` going missing, or the transcription endpoint changing shape.

## Files

```
main.js                     app lifecycle, the waiting → notify + speak reaction
preload.js                  context bridge
src/helpers/                main process
  agent.js                  spawn, NDJSON parse, state machine
  windowConfig.js           pill geometry, always-on-top, work-area clamping
  speak.js                  serial TTS queue over `say`
  voice.js                  hotkey, mic permission, target routing
  transcribe.js             OpenAI BYOK (Groq is a 4-line swap)
  secrets.js                safeStorage-backed key storage
  ipc.js                    every ipcMain handler
src/renderer/               React + Vite + Tailwind
  App.jsx, components/, hooks/useMic.js, utils/
resources/mac/              entitlements
test/, smoke.js, smoke-voice.js
```

Vendors are a plain object in `agent.js` — `codex` and `cursor-agent` are two
more entries with different args, not a class hierarchy.

## Scope

In: session roster, spoken turn-end briefs, the waiting tab, approve/deny,
voice and typed replies.

Deliberately out, with the trigger for adding each:

- **Local whisper.cpp** — add when offline or privacy actually bites.
  `transcribe.js` is a one-function seam; a local provider slots in beside the
  cloud one.
- **Hold-to-talk on the Globe key** — add when the toggle's auto-stop starts
  clipping you. Costs a Swift helper, a `swiftc` build step, and an Input
  Monitoring permission.
- **Blocking approvals** — today the agent hits a permission wall, *stops*, and
  reports; Approve sends "go ahead" as the next turn. The real-time version is
  `--permission-prompt-tool` pointed at an MCP `approve` tool returning
  `{"behavior":"allow"}`, which pauses the CLI mid-turn until you answer.
- **codex / cursor vendors** — two more `VENDORS` entries, but neither binary is
  installed here, so the protocol can't be verified. Add them with a picker.
- **Router/WebSocket split** — add when the phone client is real. IPC now; the
  intents already have the same shape either way.

`--permission-mode acceptEdits` means agents edit files without asking, and a
headless run silently *denies* anything it can't auto-accept. That's what the
approval tab surfaces.

## Credits

The CLI protocol — flags, stdin message shape, and the `result`-settles-a-turn
behaviour — was worked out by reading
[OpenMausBot](https://github.com/milind-soni/OpenMausBot)'s
`server/drivers/claude.ts` (Apache-2.0), then verified against the shipping
`claude` binary's own schema.

The voice layer's hard-won parts are lifted from
[OpenWhispr](https://github.com/openwhispr/openwhispr) (MIT) — the speech gate
and its thresholds, the RMS meter, the waveform curve, the recorder graph
(including the muted-gain trick, without which the analyser reads flat zeros
forever), and the macOS overlay behaviour: `skipTransformProcessType`, and
clamping window bounds to the display's work area rather than flooring at zero.
Each lifted file names its origin at the top. OpenWhispr has no TTS — that half
is `say`.
