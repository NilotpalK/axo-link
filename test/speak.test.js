'use strict';
// The pill's whole promise is that you can act on what you heard without
// looking. That fails two ways: the sentence is wrong, or two agents talk over
// each other and you can't tell which one you just answered.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createSpeaker, line, forSpeech } = require('../src/helpers/speak');

function fakeSay() {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.kill = () => child.emit('exit', 0);
    calls.push({ cmd, args, child });
    return child;
  };
  spawnFn.calls = calls;
  spawnFn.last = () => calls[calls.length - 1];
  return spawnFn;
}

test('an approval request says which agent, what it did, and what it wants', () => {
  assert.equal(
    line({
      label: 'axo-link',
      waiting_kind: 'approval_request',
      did: 'Edit ×2, Bash',
      summary: 'I could not delete the stale build output without permission.',
      pending: ['Bash(rm -rf ./build)'],
    }),
    'axo-link needs approval. Ran Edit 2 times, Bash. ' +
      'I could not delete the stale build output without permission. ' +
      'Wants to run Bash rm -rf ./build.'
  );
});

test('a finished turn and a question read differently', () => {
  const base = { label: 'trumio-be', did: 'Read', summary: 'Done.' };
  assert.match(line({ ...base, waiting_kind: 'finished' }), /^trumio-be is done\./);
  assert.match(line({ ...base, waiting_kind: 'question' }), /^trumio-be has a question\./);
  // An unclassified turn still gets a sentence rather than "undefined".
  assert.match(line({ ...base, waiting_kind: null }), /^trumio-be is waiting on you\./);
});

test('forSpeech flattens shapes built for the eye', () => {
  assert.equal(forSpeech('Edit ×3'), 'Edit 3 times');
  assert.equal(forSpeech('Bash(npm test)'), 'Bash npm test');
  assert.equal(forSpeech('  a\n  b '), 'a b');
});

test('two agents settling together take turns instead of overlapping', () => {
  const say = fakeSay();
  const speaker = createSpeaker(say);

  speaker.speak('first');
  speaker.speak('second');
  assert.equal(say.calls.length, 1, 'the second line must wait for the first to finish');
  assert.ok(say.calls[0].args.includes('first'));

  say.calls[0].child.emit('exit', 0);
  assert.equal(say.calls.length, 2);
  assert.ok(say.calls[1].args.includes('second'));

  say.calls[1].child.emit('exit', 0);
  assert.equal(say.calls.length, 2, 'an empty queue must not respawn');
});

test('text goes after `--`, so a summary starting with a dash is not a flag', () => {
  const say = fakeSay();
  createSpeaker(say).speak('-v evil');
  const { cmd, args } = say.last();
  assert.equal(cmd, 'say');
  assert.equal(args[args.length - 2], '--');
  assert.equal(args[args.length - 1], '-v evil');
});

test('a missing `say` binary does not wedge the queue', () => {
  const say = fakeSay();
  const speaker = createSpeaker(say);
  speaker.speak('one');
  speaker.speak('two');
  say.calls[0].child.emit('error', new Error('ENOENT'));
  assert.equal(say.calls.length, 2, 'a spawn error must still advance the queue');
});

test('lastId follows what is playing, not what was queued', () => {
  const say = fakeSay();
  const speaker = createSpeaker(say);

  speaker.speak('first', 'id-a');
  speaker.speak('second', 'id-b');
  // Both are queued, but only the first is audible -- barging in now answers A.
  assert.equal(speaker.lastId, 'id-a');

  say.calls[0].child.emit('exit', 0);
  assert.equal(speaker.lastId, 'id-b');
});

test('silence() drops the backlog and kills what is talking', () => {
  const say = fakeSay();
  const speaker = createSpeaker(say);
  speaker.speak('one');
  speaker.speak('two');
  speaker.speak('three');

  speaker.silence();
  assert.equal(speaker.speaking, false);
  assert.equal(say.calls.length, 1, 'killing the current line must not start the next one');
});
