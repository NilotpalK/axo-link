'use strict';
// API keys, encrypted at rest by the OS keychain through Electron's own
// safeStorage.
//
// ponytail: OpenWhispr's secretCrypto.js wraps @napi-rs/keyring and falls back
// to safeStorage when the keychain is unavailable. That fallback is the whole
// feature for a single-process app, so this is the fallback without the native
// dep. Ceiling: keys are readable by anything running as this user that can
// also call safeStorage -- add the keyring if that ever matters.
const fs = require('node:fs');
const path = require('node:path');

// Required lazily so smoke-voice.js can exercise the transcription path under
// plain `node` with the key in the environment, the way smoke.js runs.
const electron = () => require('electron');

const fileFor = (name) =>
  path.join(electron().app.getPath('userData'), 'secrets', `${name}.enc`);

function get(name) {
  try {
    return electron().safeStorage.decryptString(fs.readFileSync(fileFor(name)));
  } catch {
    return null;   // absent, no electron, or written by a keychain we can't read
  }
}

function set(name, value) {
  const { safeStorage } = electron();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('no OS keychain available to encrypt the key');
  }
  const target = fileFor(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write-then-rename: a crash mid-write can't leave a truncated key behind.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, electron().safeStorage.encryptString(value), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

module.exports = { get, set };
