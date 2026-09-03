'use strict';
// Reads a settled turn out loud, so you can decide without looking.
//
// ponytail: macOS `say` -- already on the machine, offline, no key, no network
// round-trip. Ceiling: it sounds like a robot. Upgrade path is the body of
// #play() and nothing else; the queue and the line-building stay as they are.
// Windows/Linux are silent (the pill still notifies) -- add a backend when
// someone actually runs this off macOS.
const { spawn } = require('node:child_process');

const VOICE = 'Ava';        // `say -v '?'` lists the rest
const RATE = 190;           // words/min; 175 is the macOS default, slightly brisk reads better

/** `say` reads punctuation literally, so shapes built for the eye have to be
 *  flattened first: "Edit x2" is a tally, "Bash(rm -rf x)" is a call signature. */
const forSpeech = (s) => String(s || '')
  .replace(/×(\d+)/g, '$1 times')
  .replace(/\(([^)]*)\)/g, ' $1')
  .replace(/\s+/g, ' ')
  .trim();

const HEADLINE = {
  approval_request: 'needs approval',
  question: 'has a question',
  finished: 'is done',
};

/** What a settled session sounds like. brief() in agent.js already capped the
 *  summary at two sentences precisely so it stands alone when read aloud. */
function line(s) {
  const approval = s.waiting_kind === 'approval_request';
  return forSpeech([
    `${s.label} ${HEADLINE[s.waiting_kind] || 'is waiting on you'}.`,
    s.did && `Ran ${s.did}.`,
    s.summary,
    approval && s.pending?.[0] && `Wants to run ${s.pending[0]}.`,
  ].filter(Boolean).join(' '));
}

/** Serial queue: two agents settling together must take turns, not talk over
 *  each other -- and whichever one is talking owns the mic, because that is the
 *  one you are answering. */
function createSpeaker(spawnFn = spawn) {
  const queue = [];
  let current = null;
  let lastId = null;
  const enabled = process.platform === 'darwin';

  const drain = () => {
    if (current || !queue.length) return;
    const item = queue.shift();
    // Stamped here rather than at enqueue time: with two lines queued you hear
    // the first one and barge in on *it*, so the reply has to route there.
    lastId = item.id;
    // `--` so a summary starting with "-" is never parsed as a flag. No shell,
    // so the text stays an argv entry and can't be injected through.
    current = spawnFn('say', ['-v', VOICE, '-r', String(RATE), '--', item.text], { stdio: 'ignore' });
    const next = () => { current = null; drain(); };
    current.on('exit', next);
    current.on('error', next);   // no `say` on this box -- stay quiet, keep draining
  };

  return {
    speak(text, id = null) {
      if (!enabled || !text) return;
      queue.push({ text, id });
      drain();
    },
    /** Barge-in: you started talking, so it stops. */
    silence() {
      queue.length = 0;
      current?.kill();
    },
    get speaking() { return current !== null; },
    /** The session whose line is playing (or played last) -- the voice target. */
    get lastId() { return lastId; },
    /** Drop that claim. Clicking a session in the pill is a stronger statement
     *  of who you are talking to than something having spoken a while ago. */
    forget() { lastId = null; },
  };
}

module.exports = { createSpeaker, line, forSpeech };
