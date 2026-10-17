'use strict';
// How any session's turn is summed up for the pill and for axo's voice:
// a spoken-length brief, what it did, what it wants to run, and whether it
// ended on a question. Used by every kind of session, for every agent.

/** First two sentences, hard-capped. This is what gets spoken, so it has to
 *  stand alone -- no "as mentioned above". */
const brief = (s, max = 200) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.*?[.!?](?:\s+.*?[.!?])?(?=\s|$)/);
  const out = m ? m[0] : t;
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '\u2026' : out;
};

/** a turn that ends on a question is waiting on an answer, not just done */
const kindOf = (summary) => (/\?["')\]]*\s*$/.test(summary) ? 'question' : 'finished');

/** "Edit x3, Bash x2" -- what it did, without asking a model to summarise. */
const tally = (names) => {
  const c = new Map();
  for (const n of names) c.set(n, (c.get(n) || 0) + 1);
  return [...c].map(([n, k]) => (k > 1 ? `${n} \u00d7${k}` : n)).join(', ');
};

/** The interesting half of a tool call, for "wants to run: Bash(rm -rf /)".
 *  Whole, not a preview: you approve what you read, so it can't be cut short.
 *  The cap only stops a pathological input from flooding the pill. */
const argText = (input) => {
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.pattern
    ?? input?.url ?? (input && JSON.stringify(input));
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 2000 ? s.slice(0, 1999) + '\u2026' : s;
};

module.exports = { brief, tally, argText, kindOf };
