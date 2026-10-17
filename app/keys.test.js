'use strict';
// The hotkey machine decides when the mic is live. If it misfires, the pill
// either eats a Windows shortcut or misses you talking.
const test = require('node:test');
const assert = require('node:assert');
const { hotkeys, invalid, TAP_MS } = require('./keys');

function rig() {
  let t = 0;
  const log = [];
  const hk = hotkeys({ dictate: ['Ctrl', 'Meta'], talk: ['Ctrl', 'Meta', 'Alt'] }, {
    onBegin: (m) => log.push(`begin ${m}`),
    onEnd: (m, { cancel }) => log.push(`${cancel ? 'cancel' : 'end'} ${m}`),
    onLock: (m) => log.push(`lock ${m}`),
    now: () => t,
  });
  return { hk, log, wait: (ms) => { t += ms; } };
}

test('hold to talk, release to send; left and right modifiers are the same key', () => {
  const { hk, log, wait } = rig();
  hk.down('CtrlRight'); hk.down('Meta'); hk.down('Meta');   // the second is auto-repeat
  wait(800); hk.up('Meta'); hk.up('CtrlRight');
  assert.deepEqual(log, ['begin dictate', 'end dictate']);
});

test('a tap goes hands-free, and the next press ends it', () => {
  const { hk, log, wait } = rig();
  hk.down('Ctrl'); hk.down('Meta'); wait(TAP_MS - 50); hk.up('Meta'); hk.up('Ctrl');
  wait(5000);
  hk.down('Ctrl'); hk.down('Meta'); hk.up('Meta'); hk.up('Ctrl');
  assert.deepEqual(log, ['begin dictate', 'lock dictate', 'end dictate']);
});

test("the pill's ✓ finishes a hands-free recording and ✕ discards one; with nothing recording they do nothing", () => {
  const { hk, log, wait } = rig();
  hk.down('Ctrl'); hk.down('Meta'); wait(TAP_MS - 50); hk.up('Meta'); hk.up('Ctrl');
  hk.finish(false);
  hk.down('Ctrl'); hk.down('Meta'); wait(TAP_MS - 50); hk.up('Meta'); hk.up('Ctrl');
  hk.finish(true);
  hk.finish(false);
  assert.deepEqual(log, ['begin dictate', 'lock dictate', 'end dictate', 'begin dictate', 'lock dictate', 'cancel dictate']);
});

test('adding Alt switches dictation to talking to axo; another shortcut cancels', () => {
  const { hk, log, wait } = rig();
  hk.down('Ctrl'); hk.down('Meta'); hk.down('Alt'); wait(800); hk.up('Alt'); hk.up('Meta'); hk.up('Ctrl');
  hk.down('Ctrl'); hk.down('Meta'); hk.down('ArrowRight');   // Ctrl+Win+Right switches desktops
  hk.up('ArrowRight'); hk.up('Meta'); hk.up('Ctrl');
  assert.deepEqual(log, [
    'begin dictate', 'cancel dictate', 'begin talk', 'end talk',
    'begin dictate', 'cancel dictate',
  ]);
});

test('a recording replaced by a newer one knows it is stale', () => {
  let t = 0, cancelled;
  const hk = hotkeys({ dictate: ['Ctrl', 'Meta'], talk: ['Ctrl', 'Meta', 'Alt'] }, {
    onBegin: () => {},
    onEnd: (m, info) => { if (m === 'dictate') cancelled = info; },
    now: () => t,
  });
  hk.down('Ctrl'); hk.down('Meta');
  hk.down('Alt');   // dictation is cancelled, talking to axo begins
  assert.equal(cancelled.cancel, true);
  assert.equal(cancelled.stale(), true, 'its late "idle" must not switch off the new mic');

  hk.up('Alt'); hk.up('Meta'); hk.up('Ctrl');
  let last;
  const hk2 = hotkeys({ dictate: ['Ctrl', 'Meta'] }, { onBegin: () => {}, onEnd: (m, info) => { last = info; }, now: () => t });
  hk2.down('Ctrl'); hk2.down('Meta'); t += 800; hk2.up('Meta');
  assert.equal(last.stale(), false, 'a plain release stays current until the next press');
});

test('recording a chord captures the widest set held; accidental chords are refused', () => {
  const { hk, log } = rig();
  let got;
  hk.record((c) => { got = c; });
  hk.down('Ctrl'); hk.down('Shift'); hk.down('Space'); hk.up('Space'); hk.up('Shift'); hk.up('Ctrl');
  assert.deepEqual(got, ['Ctrl', 'Shift', 'Space']);
  assert.deepEqual(log, [], 'recording must not open the mic');

  assert.match(invalid(['Shift', 'A']), /Ctrl, Alt or Win/);
  assert.match(invalid(['Meta', 'Ctrl'], [['Ctrl', 'Meta']]), /already used/);
  assert.equal(invalid(['Ctrl', 'Meta']), null);
});
