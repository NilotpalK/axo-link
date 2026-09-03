'use strict';
// Speech to text. Runs in main so the key never crosses into the renderer.
//
// ponytail: these four constants are the whole provider. Groq serves the same
// shape at api.groq.com/openai/v1/audio/transcriptions with
// whisper-large-v3-turbo, so switching is this block and nothing else. A local
// whisper.cpp provider would slot in beside transcribe() as a second branch --
// add it when offline or privacy actually bites, not before.
const secrets = require('./secrets');

const BASE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'gpt-4o-mini-transcribe';
const KEY_NAME = 'openai';
const KEY_ENV = 'OPENAI_API_KEY';
const TIMEOUT_MS = 30000;

const noKey = () => Object.assign(new Error('No transcription key set.'), { code: 'NO_KEY' });

const readKey = () => process.env[KEY_ENV] || secrets.get(KEY_NAME);

/** @param {ArrayBuffer} audio WebM/Opus from the renderer's MediaRecorder. */
async function transcribe(audio) {
  const key = readKey();
  if (!key) throw noKey();

  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/webm' }), 'take.webm');
  form.append('model', MODEL);
  form.append('response_format', 'json');

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`transcription failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const { text } = await res.json();
  return String(text || '').trim();
}

module.exports = { transcribe, readKey, saveKey: (k) => secrets.set(KEY_NAME, k), KEY_ENV };
