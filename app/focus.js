'use strict';
// Where you're dictating: the focused window's app and title, and -- for a
// terminal or editor -- which coding agent runs under it. classify() turns that
// into a coarse kind and an agent name; only those two go to the hub, with the
// dictation, so its clean-up fits. The window title and process list never
// leave this machine.

const { spawn } = require('node:child_process');

// the coding agents Wispr Flow looks for, by the names their CLIs run under
const AGENTS = ['claude', 'codex', 'gemini', 'aider', 'opencode', 'cursor-agent', 'qwen', 'cline'];
const KINDS = [
  ['terminal', /^(windowsterminal|openconsole|conhost|cmd|powershell|pwsh|wezterm-gui|alacritty|mintty|hyper|tabby|warp|ghostty|kitty|iterm2|terminal)$/i],
  ['editor', /^(code|code - insiders|cursor|windsurf|zed|sublime_text|idea64|webstorm64|pycharm64|rider64|devenv)$/i],
  ['chat', /^(slack|teams|ms-teams|discord|whatsapp|telegram|signal)$/i],
  ['email', /^(outlook|olk|thunderbird|mail)$/i],
  ['document', /^(winword|notion|obsidian|onenote|notepad|notepad\+\+|wordpad)$/i],
  ['browser', /^(chrome|msedge|firefox|brave|arc|opera|vivaldi|safari)$/i],
];
const named = (text, name) => new RegExp(`(^|[^a-z-])${name}([^a-z-]|$)`).test(text);

/** {app, title, procs} -> {kind, agent, confidence}; all three null when unknown */
function classify({ app = '', title = '', procs = [] } = {}) {
  const t = String(title).toLowerCase();
  let kind = KINDS.find(([, re]) => re.test(app))?.[0] ?? null;
  // a browser tab says what it really is in its title
  if (kind === 'browser') {
    kind = /gmail|outlook|inbox|mail/.test(t) ? 'email'
      : /slack|teams|discord|whatsapp|messenger|chat/.test(t) ? 'chat'
      : /google docs|notion|docs\.google/.test(t) ? 'document' : 'browser';
  }
  // An agent named in the window title is a strong sign. One merely running
  // somewhere under the terminal is a weak one: it may be in another tab.
  const inTitle = kind === 'terminal' || kind === 'editor' ? AGENTS.find((n) => named(t, n)) : null;
  const running = kind === 'terminal' || kind === 'editor'
    ? AGENTS.find((n) => procs.some((p) => named(String(p).toLowerCase(), n))) : null;
  const agent = inTitle || running || null;
  return { kind, agent, confidence: agent ? (inTitle ? 'high' : 'low') : null };
}

// A PowerShell that stays up and answers one line per question: the
// foreground window's process and title, and on "tree" the programs running
// under it. Compiling the user32 bindings once makes each answer quick.
const SCRIPT = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $h = [Fg]::GetForegroundWindow(); $sb = New-Object System.Text.StringBuilder 512; [void][Fg]::GetWindowText($h, $sb, 512)
  $fpid = [uint32]0; [void][Fg]::GetWindowThreadProcessId($h, [ref]$fpid)
  $p = Get-Process -Id $fpid -ErrorAction SilentlyContinue
  $procs = @()
  if ($line -eq 'tree') {
    $kids = @{}
    foreach ($q in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine)) { $kids[[int]$q.ParentProcessId] += ,$q }
    $todo = [System.Collections.Stack]::new(); $todo.Push([int]$fpid)
    while ($todo.Count -and $procs.Count -lt 300) {
      foreach ($c in $kids[$todo.Pop()]) { $cmd = "$($c.Name) $($c.CommandLine)"; $procs += $cmd.Substring(0, [Math]::Min(300, $cmd.Length)); $todo.Push([int]$c.ProcessId) }
    }
  }
  [Console]::Out.WriteLine((@{ app = "$($p.ProcessName)"; title = $sb.ToString(); procs = $procs } | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}`;

/** where() -> {app, title, procs} of the focused window, or null if it can't tell */
function focusWatcher({ timeout = 2500 } = {}) {
  // ponytail: Windows only; macOS would ask osascript for the frontmost app and window
  if (process.platform !== 'win32') return { where: async () => null, stop() {} };
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const waiting = [];
  let buf = '', dead = false;
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) !== -1;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let v = null;
      try { v = JSON.parse(line); } catch { /* a stray line from PowerShell */ }
      waiting.shift()?.(v);
    }
  });
  const die = () => { dead = true; for (const r of waiting.splice(0)) r(null); };
  ps.on('exit', die);
  ps.on('error', die);
  return {
    where(tree = true) {
      if (dead) return Promise.resolve(null);
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        waiting.push(finish);
        // too slow is no answer; its late reply is matched to this slot and dropped
        setTimeout(() => finish(null), timeout).unref();
        ps.stdin.write(tree ? 'tree\n' : 'window\n');
      });
    },
    stop() { dead = true; ps.kill(); },
  };
}

module.exports = { classify, focusWatcher, AGENTS };
