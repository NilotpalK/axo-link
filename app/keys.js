'use strict';
// Wispr-style global hotkeys: hold a chord to talk, release to send; tap it to
// go hands-free, press it again to stop. Electron's globalShortcut can't see
// key-up or modifier-only chords like Ctrl+Win, so this rides a low-level hook.
//
// hotkeys() is the pure state machine (tested); hook() feeds it real keys.

const TAP_MS = 300;   // shorter than this is a tap -> hands-free

// Left and right modifiers are the same key to a person.
const norm = (name) => name.replace(/Right$/, '');
const MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
const same = (set, combo) => set.size === combo.length && combo.every((k) => set.has(k));

/** combos: { mode: ['Ctrl', 'Meta'], ... }  ->  { down(key), up(key), record(cb) } */
function hotkeys(combos, { onBegin, onEnd, onLock = () => {}, now = Date.now }) {
  const held = new Set();
  let active = null, locked = false, t0 = 0, recording = null, widest = [], gen = 0;

  const hit = () => Object.keys(combos).find((m) => same(held, combos[m]));
  const begin = (m) => { gen++; active = m; locked = false; t0 = now(); onBegin(m); };
  // stale() turns true once a newer recording has begun, so a slow finish
  // (paste, clean-up) can't touch the pill while you're already talking again
  const end = (cancel) => {
    const m = active, g = gen;
    active = null; locked = false;
    onEnd(m, { cancel, stale: () => gen !== g });
  };

  return {
    down(key) {
      key = norm(key);
      if (held.has(key)) return;   // auto-repeat while held
      held.add(key);
      if (recording) { if (held.size > widest.length) widest = [...held]; return; }
      const m = hit();
      if (locked) { if (m === active) end(false); return; }   // second press ends hands-free
      if (m && m !== active) { if (active) end(true); begin(m); return; }   // Ctrl+Win -> Ctrl+Win+Alt
      if (active && !m) end(true);   // Ctrl+Win+Right etc: another shortcut, not us
    },
    up(key) {
      key = norm(key);
      held.delete(key);
      if (recording) {
        if (!held.size) { const cb = recording; recording = null; cb(widest); }
        return;
      }
      if (!active || locked || !combos[active].includes(key)) return;
      if (now() - t0 < TAP_MS) { locked = true; onLock(active); } else end(false);
    },
    /** capture the next chord the user presses, for the settings screen */
    record(cb) { if (active) end(true); held.clear(); widest = []; recording = cb; },
    /** the pill's ✓ and ✕: finish or discard the recording without the keys */
    finish(cancel) { if (active) end(cancel); },
    set(next) { combos = next; },
  };
}

/** a chord someone could hit by accident while typing is no hotkey */
function invalid(combo, others = []) {
  if (!combo.some((k) => MODIFIERS.has(k) && k !== 'Shift')) return 'Use at least one of Ctrl, Alt or Win.';
  if (others.some((o) => same(new Set(o), combo))) return 'That chord is already used.';
  return null;
}

const label = (combo) => combo
  .map((k) => (k === 'Meta' ? (process.platform === 'darwin' ? 'Cmd' : 'Win') : k))
  .join(' + ');

/** feed real keystrokes from the OS into a hotkeys() machine */
function hook(hk) {
  const { uIOhook, UiohookKey } = require('uiohook-napi');
  const names = new Map(Object.entries(UiohookKey).map(([n, c]) => [c, n]));
  uIOhook.on('keydown', (e) => { const n = names.get(e.keycode); if (n) hk.down(n); });
  uIOhook.on('keyup', (e) => { const n = names.get(e.keycode); if (n) hk.up(n); });
  uIOhook.start();
  return {
    paste: () => uIOhook.keyTap(UiohookKey.V, [process.platform === 'darwin' ? UiohookKey.Meta : UiohookKey.Ctrl]),
    stop: () => uIOhook.stop(),
  };
}

module.exports = { hotkeys, invalid, label, hook, TAP_MS };
