'use strict';
// Claude, spawned: the sessions the pill's + button starts. `claude -p` with
// stream-json on stdin and stdout; permission prompts come back as
// control_requests and are answered mid-turn. Verified against OpenMausBot's
// server/drivers/claude.ts (Apache-2.0, github.com/milind-soni/OpenMausBot)
// and against the shipping `claude` binary's own schema.
// The vendor shape (cmd, args, write, answer, parse, turn) is what
// agents/sessions.js expects of every agent.
const { brief, tally, argText, kindOf } = require('../summary');

const blockText = (msg) => (Array.isArray(msg?.content) ? msg.content : [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('')
  .trim();

const freshTurn = () => ({ tools: [], text: '', asks: [] });
const asking = (turn) => ({
  state: 'waiting', waiting_kind: 'approval_request',
  pending: turn.asks.map((a) => a.label),
  pending_ids: turn.asks.map((a) => a.id),   // what an approval has to name
  summary: brief(turn.text), did: tally(turn.tools),
});

module.exports = {
  cmd: 'claude',
  args: (sid) => [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',                        // required by stream-json output
    '--permission-mode', 'acceptEdits',
    // anything acceptEdits won't auto-allow comes back to us as a
    // control_request, and the CLI pauses mid-turn until we answer it
    '--permission-prompt-tool', 'stdio',
    '--session-id', sid,
  ],
  write: (t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } }) + '\n',
  answer: (ask, allow, why) => JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: ask.id,
      response: allow ? { behavior: 'allow', updatedInput: ask.input } : { behavior: 'deny', message: why },
    },
  }) + '\n',
  // (line, per-turn scratch, write-to-stdin) -> state patch, or null for lines we ignore
  parse: (o, turn, reply) => {
    if (o.type === 'system' && o.subtype === 'init') return { model: o.model };

    // Mid-turn permission prompt. Shape read out of claude 2.1.296:
    // {type:'control_request', request_id, request:{subtype:'can_use_tool', tool_name, input, ...}}
    if (o.type === 'control_request') {
      const r = o.request || {};
      if (r.subtype !== 'can_use_tool') {
        // never leave the CLI blocked on a request we don't handle
        reply(JSON.stringify({
          type: 'control_response',
          response: { subtype: 'error', request_id: o.request_id, error: `unsupported: ${r.subtype}` },
        }) + '\n');
        return null;
      }
      turn.asks.push({ id: o.request_id, input: r.input, label: `${r.tool_name}(${argText(r.input)})` });
      return asking(turn);
    }
    if (o.type === 'control_cancel_request') {
      if (!turn.asks.some((a) => a.id === o.request_id)) return null;
      turn.asks = turn.asks.filter((a) => a.id !== o.request_id);
      return turn.asks.length ? asking(turn) : { state: 'running', waiting_kind: null, pending: [], pending_ids: [] };
    }

    if (o.type === 'assistant') {
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b.type === 'tool_use') turn.tools.push(b.name);
      }
      const t = blockText(o.message);
      if (!t) return null;
      turn.text = t;
      return { last: t };
    }

    if (o.type === 'result') {
      // approvals are answered mid-turn now, so a settled turn is never
      // waiting on one -- anything in permission_denials we denied ourselves
      const summary = brief(o.result || turn.text);
      const did = tally(turn.tools);
      // the turn ends here, not when you send: a reply sent mid-task goes
      // into the running turn (claude 2.1.301: one result covers both)
      Object.assign(turn, freshTurn());
      return {
        state: o.is_error === true ? 'error' : 'waiting',
        waiting_kind: kindOf(summary),
        pending: [], pending_ids: [],
        summary, did,
      };
    }
    return null;
  },
  // a fresh turn's scratch: tools run, last text, pending approvals (sessions.js reads `asks`)
  turn: freshTurn,
};
