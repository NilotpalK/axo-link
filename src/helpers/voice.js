'use strict';
// The listen half: a hotkey opens the mic, the transcript becomes the next turn.
const { globalShortcut, systemPreferences, ipcMain } = require('electron');
const { transcribe, readKey, saveKey } = require('./transcribe');
const { postTurn } = require('./layer-hub');

// F13 rather than a chord: nothing else claims it, so there is no input-method
// or Spotlight clash to debug. Keyboards without one usually get it by remapping
// caps lock in Karabiner, which is the common dictation setup anyway.
const HOTKEY = 'F13';

function registerVoice({ sessions, speaker, getWindow }) {
  let selectedId = null;

  /** Who you are answering, most-specific first:
   *  1. whatever just spoke -- you are replying to what you heard
   *  2. the only thing waiting, if there is exactly one
   *  3. whatever the pill has selected */
  const resolveTarget = () => {
    const list = sessions.list();
    const spoken = list.find((s) => s.id === speaker.lastId);
    if (spoken) return spoken;
    const waiting = list.filter((s) => s.state === 'waiting');
    if (waiting.length === 1) return waiting[0];
    return list.find((s) => s.id === selectedId) || null;
  };

  ipcMain.on('select', (_e, id) => {
    selectedId = id;
    // Explicit click beats "something spoke a while ago".
    speaker.forget();
  });

  ipcMain.handle('voice', async (_e, targetId, audio) => {
    try {
      const text = await transcribe(audio);
      if (!text) return { ok: false, error: 'Nothing heard.' };
      // ponytail: no intent parsing. approve()/deny() in agent.js are already
      // just send() with canned English, and the receiver is an LLM -- "yeah go
      // ahead" and "no, use redis instead" are both simply the next turn.
      const local = sessions.send(targetId, text);
      // ALSO forward wearer turns to the Layer hub when configured.
      let hubOk = false;
      try {
        const hub = await postTurn(text);
        hubOk = Boolean(hub.ok);
      } catch (e) {
        console.warn('[layer-hub] postTurn failed:', e.message || e);
      }
      if (local) return { ok: true, text };
      if (sessions.isHub(targetId) && hubOk) {
        const prev = sessions.list().find((s) => s.id === targetId);
        if (prev) {
          sessions.upsertExternal({
            ...prev, state: 'idle', waiting_kind: null, last: text,
          });
        }
        return { ok: true, text };
      }
      return { ok: false, error: 'That session is gone.', text };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code };
    }
  });

  ipcMain.handle('has-key', () => Boolean(readKey()));
  ipcMain.handle('set-key', (_e, key) => {
    const trimmed = String(key || '').trim();
    if (!trimmed) return false;
    saveKey(trimmed);
    return true;
  });

  const onHotkey = async () => {
    // Barge-in: you started talking, so it stops. Also means there is no
    // speaker output left for the mic to pick up.
    speaker.silence();

    const win = getWindow();
    if (!win || win.isDestroyed()) return;

    if (
      process.platform === 'darwin' &&
      systemPreferences.getMediaAccessStatus('microphone') !== 'granted'
    ) {
      if (!(await systemPreferences.askForMediaAccess('microphone'))) {
        speaker.speak('Microphone access is off for axo link.');
        return;
      }
    }

    // The renderer stops if it is already recording and ignores the payload;
    // the target is resolved once, at mic-open, so it can't shift mid-sentence.
    const target = resolveTarget();
    win.webContents.send(
      'mic',
      target
        ? { targetId: target.id, targetLabel: target.label }
        : { error: 'Nothing to answer yet.' }
    );
  };

  if (!globalShortcut.register(HOTKEY, onHotkey)) {
    console.warn(`[voice] ${HOTKEY} is already taken -- voice input is off`);
  }

  return { HOTKEY, resolveTarget };
}

module.exports = { registerVoice, HOTKEY };
