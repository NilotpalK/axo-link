'use strict';
// Live check for the voice layer. speechGate.test.mjs and speak.test.js prove
// the logic against fakes; this proves the two things a fake can never catch --
// that `say` still exists on this machine, and that the transcription endpoint
// still answers in the shape transcribe() unpacks.
//
//   OPENAI_API_KEY=sk-... node smoke-voice.js
//
// Synthesises a sentence with `say`, encodes it to the same WebM/Opus the
// renderer's MediaRecorder produces, and round-trips it back to text.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { transcribe, readKey, KEY_ENV } = require('./src/helpers/transcribe');
const { createSpeaker, line } = require('./src/helpers/speak');

const SENTENCE = 'Approved, go ahead, but use redis instead of memcached.';
const MUST_CONTAIN = ['approved', 'redis'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'axo-voice-'));
const aiff = path.join(tmp, 'take.aiff');
const webm = path.join(tmp, 'take.webm');
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

const fail = (why) => {
  console.error('FAIL --', why);
  cleanup();
  process.exit(1);
};

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error?.code === 'ENOENT') fail(`${cmd} is not installed`);
  if (r.status !== 0) fail(`${cmd} exited ${r.status}: ${(r.stderr || '').slice(-300)}`);
};

(async () => {
  // 1. The speak half -- proves `say` runs and the queue drains.
  const sample = line({
    label: 'axo-link',
    waiting_kind: 'approval_request',
    did: 'Edit ×2, Bash',
    summary: 'I could not delete the stale build output without permission.',
    pending: ['Bash(rm -rf ./build)'],
  });
  console.log('speak:', sample);
  await new Promise((resolve) => {
    const speaker = createSpeaker();
    speaker.speak(sample, 'smoke');
    if (!speaker.speaking) return resolve();   // non-darwin: silent by design
    const t = setInterval(() => {
      if (!speaker.speaking) {
        clearInterval(t);
        resolve();
      }
    }, 100);
  });
  console.log('   -- said it, queue drained');

  // 2. The listen half.
  if (!readKey()) fail(`no transcription key. Set ${KEY_ENV} or save one in the pill.`);

  run('say', ['-o', aiff, '--', SENTENCE]);
  // libopus in a WebM container is exactly what MediaRecorder hands us, so the
  // endpoint sees the same bytes it will see in production.
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff,
    '-c:a', 'libopus', '-ar', '48000', '-f', 'webm', webm]);

  const audio = fs.readFileSync(webm);
  console.log(`transcribe: ${audio.length} bytes of webm/opus`);

  const t0 = Date.now();
  const text = await transcribe(
    audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)
  );
  console.log(`   -> ${JSON.stringify(text)}  (${Date.now() - t0}ms)`);

  const got = text.toLowerCase();
  const missing = MUST_CONTAIN.filter((w) => !got.includes(w));
  if (missing.length) fail(`transcript is missing ${missing.join(', ')}`);

  console.log('PASS -- say works, and the endpoint still returns { text }');
  cleanup();
})().catch((e) => fail(e.message));
