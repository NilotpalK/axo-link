'use strict';
// Live check against the real CLI: does a turn actually settle, does the
// process survive to take a second turn, and does a permission prompt pause
// the turn until we answer it? agent.test.js proves the parsing with a fake;
// this proves the CLI still behaves the way the parser assumes.
//   node scripts/smoke.js
const os = require('node:os');
const { Sessions } = require('../agents/sessions');

const s = new Sessions();
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6);
const id = s.start({ label: 'smoke', cwd: os.tmpdir() });
let turn = 1, asked = false;

s.on('update', (l) => console.log(ms(), l[0].state.padEnd(8),
  JSON.stringify((l[0].pending[0] || l[0].last || l[0].prompt || '').slice(0, 70))));
s.on('waiting', (rec) => {
  if (rec.waiting_kind === 'approval_request') {
    asked = true;
    console.log(ms(), 'permission prompt arrived mid-turn -- approving');
    if (!s.approve(id, rec.pending_ids)) fail('could not answer the prompt');
    return;
  }
  if (turn++ === 1) {
    console.log(ms(), 'turn 1 settled -- turn 2 needs a permission prompt');
    if (!s.send(id, 'Use the Bash tool to run exactly this, then reply "done": node -e "process.exit(0)"')) {
      fail('process died after turn 1');
    }
    return;
  }
  console.log(ms(), asked
    ? 'PASS -- turns settle, the session persists, and an approval pauses then resumes the turn'
    : 'PASS (partial) -- turn 2 ran without asking; your settings may already allow that command');
  s.stop(id);
  process.exit(0);
});

const fail = (why) => { console.error(ms(), 'FAIL --', why); s.stop(id); process.exit(1); };
setTimeout(() => fail('no result event within 120s'), 120000);

console.log(ms(), 'sending turn 1');
s.send(id, 'Reply with exactly one word: pong');
