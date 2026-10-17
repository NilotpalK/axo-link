'use strict';
// Records the pill through a scripted 17 s run, so motion changes can be compared:
//   npx electron scripts/pill-reel.js app/pill.html out.mp4 [label]
// The real pill and its real preload, offscreen, zoomed 2x. Events come from this
// script instead of the hub, the mouse is real input events, and the mic is
// Chromium's fake device playing a synthetic speech-like recording.
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [pill, out, label = ''] = process.argv.slice(2);
const W = 420, H = 460, SCALE = 2, FPS = 60, SECONDS = 17;

// a 20 s mic recording: syllable-length bursts of voiced noise with pauses
const wav = path.join(os.tmpdir(), 'axo-pill-voice.wav');
{
  const sr = 48000, n = sr * 20, pcm = Buffer.alloc(44 + n * 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let env = 0, target = 0, next = 0;
  for (let i = 0; i < n; i++) {
    if (i >= next) { const talk = rnd() > 0.25; target = talk ? 0.25 + rnd() * 0.65 : 0; next = i + sr * (talk ? 0.09 + rnd() * 0.16 : 0.05 + rnd() * 0.25); }
    env += (target - env) * 0.002;
    const t = i / sr, voiced = Math.sin(2 * Math.PI * 140 * t) * 0.5 + Math.sin(2 * Math.PI * 280 * t) * 0.25;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, env * (voiced + (rnd() - 0.5) * 0.6))) * 26000), 44 + i * 2);
  }
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(sr * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(wav, pcm);
}
// Any error fails the run: its stack goes to the terminal and the exit code is 1.
// (Without this, Electron shows a modal dialog and the run hangs until someone clicks OK.)
const fail = (e) => { console.error('pill-reel failed:', e); app.exit(1); };
process.on('uncaughtException', fail);
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const agent = (id, label, state, extra = {}) => ({ id, label, state, device: 'Home PC', alive: true, since: 0, ...extra });
const CALM = [
  agent('d1', 'deskill', 'running', { summary: 'Adding exponential backoff to fetch.js.', did: 'Read ×4, Edit ×3, Bash ×2', kind: 'terminal' }),
  agent('a1', 'axo-link', 'running', { summary: 'Tagging the v0.3 release.', did: 'Edit ×1, Bash ×2' }),
  agent('o1', 'docs', 'waiting', { waiting_kind: 'finished', summary: 'Rewrote the README setup section.', did: 'Read ×6, Edit ×2', device: 'Office PC' }),
];
const WAITING = CALM.map((a) => (a.id === 'a1' ? { ...a, state: 'waiting', waiting_kind: 'approval_request',
  summary: 'Ready to push the release.', pending: ['Bash: git push origin main'], pending_ids: ['r1'] } : a));
const SETTINGS = { dictate: 'Ctrl+Win', talk: 'Ctrl+Win+Alt', mode: 'desk', mic: '', speaker: '', clean: true };
const SAY = 'axo-link wants to run git push origin main. Approve it?'.split(' ');
const silence = Buffer.alloc(24000 * 2 * 2.6).toString('base64');   // 2.6 s of axo's voice, silent

const BAR = [W / 2, H - 16], AWAY = [3, 230];   // the window's edge, outside the bar and the panel
const SCRIPT = [
  [0.0, 'sessions', CALM], [0.0, 'settings', SETTINGS],
  [0.8, 'mouse', BAR], [2.4, 'mouse', AWAY],
  [3.2, 'sessions', WAITING],
  [4.2, 'hand', CALM[2]],
  [5.0, 'voice', { state: 'listening', mode: 'talk' }],
  [7.6, 'voice', { state: 'thinking', mode: 'talk' }],
  [8.4, 'voice', { state: 'idle', mode: 'talk' }], [8.4, 'play', silence],
  ...SAY.map((w, i) => [8.5 + i * 0.16, 'caption', (i ? ' ' : '') + w]),
  [12.6, 'mouse', BAR], [12.7, 'click', BAR], [13.4, 'mouse', [W / 2, 300]], [14.6, 'mouse', AWAY],
  [15.8, 'voice', { state: 'error', kind: 'silence', mic: 'Microphone (WO Mic Device)', msg: 'Silence from Microphone (WO Mic Device). Change mic in Settings.' }],
];

app.whenReady().then(async () => {
  ipcMain.handle('list', () => CALM);
  ipcMain.handle('settings', () => SETTINGS);
  for (const ch of ['audio', 'miclabel', 'hit', 'focus', 'voice-end']) ipcMain.on(ch, () => {});
  ipcMain.handle('read', () => ({ ok: true }));
  // offscreen windows ignore the display scale, so: a 2x window with the page zoomed 2x
  const win = new BrowserWindow({ width: W * SCALE, height: H * SCALE, show: false, transparent: true, frame: false,
    // an in-memory session: Electron would otherwise save the 2x zoom for every file:// page
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'pill-reel', preload: path.resolve(__dirname, '../app/preload.js') } });
  win.webContents.setFrameRate(FPS);
  await win.loadFile(path.resolve(pill));
  win.webContents.setZoomFactor(SCALE);
  // a desktop behind the pill, and a label for side-by-side clips
  await win.webContents.insertCSS('html { background: radial-gradient(120% 90% at 30% 20%, #3a4252, #1d2129 55%, #121418); }');
  if (label) await win.webContents.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;left:14px;top:12px;font:600 13px system-ui;color:#fff;opacity:.75;letter-spacing:.08em">${label.toUpperCase()}</div>')`);

  let latest = null;
  win.webContents.on('paint', (_e, _dirty, img) => { const s = img.getSize(); if (s.width === W * SCALE && s.height === H * SCALE) latest = img.toBitmap(); });
  win.webContents.invalidate();
  while (!latest) await new Promise((r) => setTimeout(r, 10));   // the clock starts on the first frame
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W * SCALE}x${H * SCALE}`, '-r', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(out)], { stdio: ['pipe', 'inherit', 'inherit'] });

  const t0 = Date.now(), at = (s) => t0 + s * 1000;
  const send = ([t, kind, v]) => setTimeout(() => {
    const [x, y] = kind === 'mouse' || kind === 'click' ? v : [];
    if (kind === 'mouse') win.webContents.sendInputEvent({ type: 'mouseMove', x: x * SCALE, y: y * SCALE });
    else if (kind === 'click') for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: x * SCALE, y: y * SCALE, button: 'left', clickCount: 1 });
    else win.webContents.send(kind, v);
  }, Math.max(0, at(t) - Date.now()));
  SCRIPT.forEach(send);

  // one frame every 1/60 s from whatever was painted last
  for (let f = 0; f < FPS * SECONDS; f++) {
    const wait = t0 + (f * 1000) / FPS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (latest && !ff.stdin.write(latest)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await once(ff, 'close');
  if (code) return fail(new Error(`ffmpeg exited with code ${code}`));
  console.log(`wrote ${out}`);
  app.exit(0);
}).catch(fail);
