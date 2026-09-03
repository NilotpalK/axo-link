// Two ways voice input fails silently: the mic closes while you are still
// talking, or it stays open and ships room tone to the API. Both are decided
// here, from RMS alone, so both are testable without a microphone.
import test from 'node:test';
import assert from 'node:assert';
import {
  createSpeechGateState,
  recordSpeechWindow,
  getSpeechGateDecision,
  createAutoStop,
} from '../src/renderer/utils/speechGate.mjs';

// Above every speech threshold / below every one of them.
const LOUD = { rms: 0.05, peak: 0.4 };
const QUIET = { rms: 0.0005, peak: 0.001 };

const feed = (state, { rms, peak }, n = 1) => {
  for (let i = 0; i < n; i++) recordSpeechWindow(state, rms, peak);
  return state;
};

test('a take with speech in it passes the gate', () => {
  const s = feed(feed(createSpeechGateState(), QUIET, 5), LOUD, 10);
  const d = getSpeechGateDecision(s);
  assert.equal(d.skip, false);
  assert.equal(d.reason, 'speech_detected');
});

test('room tone is skipped instead of costing an API call', () => {
  const d = getSpeechGateDecision(feed(createSpeechGateState(), QUIET, 30));
  assert.equal(d.skip, true);
  assert.equal(d.reason, 'silence');
});

test('an unmeasured take fails open -- never discard audio you could not meter', () => {
  assert.deepEqual(getSpeechGateDecision(createSpeechGateState()), {
    skip: false,
    reason: 'unavailable',
  });
  assert.equal(getSpeechGateDecision(null).skip, false);
});

test('auto-stop waits out a slow start rather than cutting you off', () => {
  const stop = createAutoStop({ silenceMs: 1200, noSpeechMs: 5000 });
  // Three seconds of thinking before the first word: still under noSpeechMs.
  for (let t = 0; t < 3000; t += 80) assert.equal(stop(QUIET.rms, t), null);
  assert.equal(stop(LOUD.rms, 3080), null);
});

test('auto-stop fires after trailing silence, and not one window early', () => {
  const stop = createAutoStop({ silenceMs: 1200 });
  assert.equal(stop(LOUD.rms, 0), null);          // speech heard, timer armed
  assert.equal(stop(QUIET.rms, 100), null);       // silence starts at t=100
  assert.equal(stop(QUIET.rms, 1299), null, 'must not cut off 1ms early');
  assert.equal(stop(QUIET.rms, 1300), 'trailing_silence');
});

test('a pause mid-sentence resets the silence timer', () => {
  const stop = createAutoStop({ silenceMs: 1200 });
  stop(LOUD.rms, 0);
  stop(QUIET.rms, 100);
  stop(QUIET.rms, 1000);        // 900ms pause -- still thinking
  assert.equal(stop(LOUD.rms, 1100), null, 'speaking again must rearm');
  assert.equal(stop(QUIET.rms, 1200), null);
  assert.equal(stop(QUIET.rms, 2399), null, 'the clock restarts from the new pause');
  assert.equal(stop(QUIET.rms, 2400), 'trailing_silence');
});

test('an opened-but-unused mic closes itself', () => {
  // The clock starts at the first meter tick, so drive it the way the meter
  // does -- every 80ms from mic-open -- rather than jumping straight to 4999.
  const stop = createAutoStop({ noSpeechMs: 5000 });
  let fired = null;
  for (let t = 0; t <= 6000 && !fired; t += 80) fired = stop(QUIET.rms, t);
  assert.equal(fired, 'no_speech');
});

test('a runaway take is capped', () => {
  const stop = createAutoStop({ maxMs: 30000 });
  for (let t = 0; t < 30000; t += 1000) assert.equal(stop(LOUD.rms, t), null);
  assert.equal(stop(LOUD.rms, 30000), 'max_duration');
});
