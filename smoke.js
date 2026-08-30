'use strict';
// Live check against the real CLI: does a turn actually settle, and does the
// process survive to take a second turn? agent.test.js proves the parsing with
// a fake; this proves the CLI still behaves the way the parser assumes.
//   node smoke.js
const { Sessions } = require('./agent');

const s = new Sessions();
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);
const id = s.start({ label: 'smoke' });
let turn = 1;

s.on('update', (l) => console.log(ms(), l[0].state.padEnd(8), JSON.stringify((l[0].last || '').slice(0, 70))));
s.on('waiting', () => {
  if (turn++ === 1) {
    console.log(ms(), 'turn 1 settled -- sending turn 2 down the same stdin');
    if (!s.send(id, 'Reply with exactly one word: two')) fail('process died after turn 1');
    return;
  }
  console.log(ms(), 'PASS -- turn settles, session persists across turns');
  s.stop(id);
  process.exit(0);
});

const fail = (why) => { console.error(ms(), 'FAIL --', why); s.stop(id); process.exit(1); };
setTimeout(() => fail('no result event within 120s'), 120000);

console.log(ms(), 'sending turn 1');
s.send(id, 'Reply with exactly one word: pong');
