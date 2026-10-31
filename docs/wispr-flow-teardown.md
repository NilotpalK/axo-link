# Wispr Flow teardown

Static analysis of Wispr Flow **1.6.1167** for Windows, installed at
`%LOCALAPPDATA%\WisprFlow\app-1.6.1167`, done October 2026 to see how a mature
voice-typing app solves the problems axo's pill has. Files on disk only: the app
was not run, its traffic was not captured, and no user data was read. The client
keys embedded in the bundle (Supabase project, analytics) are deliberately not
reproduced here.

## The pieces

| Part | What it is | Job |
|---|---|---|
| `Wispr Flow.exe` | Electron, code in `resources/app.asar` (135 MB, webpack) | windows, the pill, settings, SQLite history, server calls |
| `resources/Release/Wispr Flow Helper.exe` | native helper, C# compiled ahead of time (.NET NativeAOT, 20 MB, x64) | hotkeys, typing text in, reading the focused text box, focus tracking |
| `api.wisprflow.ai` (+ `api-east`) | backend: websocket plus `/api/v1/...` | transcription, clean-up ("polish"), transforms, dictionary, teams |

The macOS build uses a Swift helper instead; one JSON schema generates the
TypeScript, Swift and C# message models (`package.json` scripts).

## How it works

### The helper

- Electron spawns the helper with an **extra pipe on file descriptor 3** as the
  IPC channel. Its stdout is treated as logs ("non-IPC"); stderr is logged.
- Messages are escaped, delimited JSON, either `HelperAPIRequest` or
  `HelperAPIResponse`, matched by request id. A keepalive timer watches it; a
  dead helper is relaunched with backoff 0, 1, 2, 4, 8, 16 s.
- About 100 message types, among them `PasteText`, `CancelPaste`, `PasteOutcome`,
  `GetTextBoxInfo`, `GetSelectedTextViaCopy`, `SimulateKeyPress`, `KeypressEvent`,
  `UpdateShortcuts`, `DictationStart`/`DictationStop`, `CursorContextUpdate`,
  `StoreFocusedAppAndElement`, `FocusStoredAppAndElement`, `AppInfoUpdate`,
  `SecureInputStatus`, `GetMicrophoneHolders`.
- Windows APIs named in the helper's strings: `SetWindowsHookEx` (global hook),
  `SendInput`, `OpenClipboard`/`SetClipboardData`, UI Automation
  (`IUIAutomation`, `TextPattern`, `ValuePattern`), `SetWinEventHook`,
  `GetForegroundWindow`, `IAudioClient`/`MMDevice`. This is inferred from names;
  the helper itself was not decompiled.

### The pill

- Window: transparent, frameless, `type: "toolbar"` on Windows (`"panel"` on
  macOS), `alwaysOnTop` at `screen-saver` level,
  `setIgnoreMouseEvents(true, { forward: true })`, visible on all workspaces.
- **Pixel-accurate click-through:** the status window polls the cursor and reads
  the window's alpha under it, so only visible pixels take clicks; when that
  capture fails it falls back to hit-testing rectangles ("catch-rect").

### Audio

- Captured in the hub window's renderer with `getUserMedia`, 16 kHz mono,
  `echoCancellation`, `noiseSuppression` and `autoGainControl` all **off**,
  through an AudioWorklet (`recorder-processor`).
- Encoded as Opus, 16 kHz mono, 64 kb/s, with a WebAssembly encoder
  (`opusscript_native_wasm.wasm`) in worker threads. Feature flags show
  `use-opus`, `stream-text` and `use-msgpack` experiments.

### What the server is told

Each dictation carries its context: app name, bundle id, window title, URL, app
type, timing, and **which coding agent is in the focused terminal**. The helper
reports `codingCliAgent` as one of `aider`, `claude`, `cline`, `codex`,
`cursor-agent`, `gemini`, `opencode`, `qwen`, with confidence `high` or `low`,
and the request sends it as `coding_cli_agent`. So the clean-up formats
differently when you dictate to Claude Code. Timing fields named `baseten…`
suggest their models are hosted on Baseten.

### Claude Code as an agent

Wispr runs the Claude Code CLI headless:

```
claude --input-format stream-json --output-format stream-json --include-partial-messages
       --verbose --model <model> --dangerously-skip-permissions
       [--resume <session>] [--effort <e>] [--disallowedTools ...] [--mcp-config <file>]
```

Tools reach the agent through a generated `--mcp-config` naming one MCP server,
`wispr-extension-tools` (`node` plus a bundled script). That server talks back to
Electron over a temporary socket (`AGENT_BRIDGE_SOCKET`) in newline-delimited
JSON: `{type: "call", toolName, arguments, requestId}` answered by
`{type: "result", requestId, result | error}`. It belongs to an extension system
that can also run terminal commands, spawn processes, stream audio and subscribe
to app and text-box changes.

### Local state

A SQLite database (`flow.sqlite`) through sequelize, with umzug migrations whose
names show what they keep: dictionary, history, end-to-end latency, edited-text
status and attempts, tone-matched text and tone-match pairs, text-box contents.
A diff library (`diff-match-patch`) is in the dependencies, apparently for
comparing what was pasted with what you edited afterwards.

## What axo should take

- **Tell the clean-up which coding agent you're talking to**, detected from the
  focused terminal. Their eight-agent list is a starting point.
- **Pixel-accurate click-through** for the pill, instead of whole rectangles.
- **Capture with echo cancellation, noise suppression and auto-gain off.**
- **Give agents tools with a temporary `--mcp-config` plus a socket**, without a
  long-running MCP server.

What not to copy:

- `--dangerously-skip-permissions`. axo's approvals are the point.
- Pasting through the clipboard alone. UI Automation can insert text without
  touching the clipboard.

## Evidence and limits

| What | Source |
|---|---|
| Electron fuses: run-as-Node and `--inspect` off, ASAR integrity not enforced | REA `inspect_electron_fuses`, `ev_cc435e3f3c4215285708f2afce83202966a940e209eb545586e6064039806474` |
| Package graph: 228 files, 3,511 modules; partial | REA `analyze_javascript_application`, `ev_c72a6537e9274c9d4e3bdd33afb8684702535b1b513bd4093adb61ad64247134` |
| Helper IPC, agent runner, overlay window, request fields | direct reads of `.webpack/main/index.js` from the archive |
| Audio settings | direct reads of `.webpack/renderer/hub/index.js` |
| Helper's Windows APIs | strings in `Wispr Flow Helper.exe` |

- REA's graph is partial: it ran out of memory on the 9.9 MB main bundle, so the
  main-process findings rest on targeted reads of that file.
- The helper was not decompiled; its behaviour is inferred from API names and
  the message types Electron sends it.
- Nothing here was observed at runtime.
