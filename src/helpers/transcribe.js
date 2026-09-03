'use strict';
// Speech to text. Runs in main so the key never crosses into the renderer.
//
// ponytail: Groq's endpoint is OpenAI-shaped, so switching provider is BASE_URL
// + MODEL and nothing else. A local whisper.cpp provider would slot in beside
// transcribe() as a second branch -- add it when offline or privacy actually
// bites, not before.
const secrets = require('./secrets');

const BASE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';
const KEY_NAME = 'groq';
const KEY_ENV = 'GROQ_API_KEY';
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
