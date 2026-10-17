'use strict';
// Where you're dictating decides how the clean-up formats it. Getting the
// agent wrong is cheap (a little formatting); claiming one with nothing to go
// on is not, so only a terminal or an editor can have an agent at all.
const test = require('node:test');
const assert = require('node:assert');
const { classify, sameWindow } = require('./focus');

test('a coding agent named in the terminal title is a strong sign; one merely running under it, a weak one', () => {
  assert.deepEqual(classify({ app: 'WindowsTerminal', title: 'claude - deskill' }), { kind: 'terminal', agent: 'claude', confidence: 'high' });
  assert.deepEqual(classify({ app: 'WindowsTerminal', title: 'PowerShell', procs: ['openconsole.exe', 'node.exe node c:\\npm\\codex\\bin\\codex.js'] }),
    { kind: 'terminal', agent: 'codex', confidence: 'low' });
  assert.deepEqual(classify({ app: 'Code', title: 'fetch.js - deskill', procs: ['claude.exe claude --resume'] }), { kind: 'editor', agent: 'claude', confidence: 'low' });
});

test('words that only contain an agent name are not that agent', () => {
  assert.equal(classify({ app: 'WindowsTerminal', title: 'claude-projects' }).agent, null, 'a folder named claude-projects');
  assert.equal(classify({ app: 'WindowsTerminal', title: 'PowerShell', procs: ['gemini-cli-notes.txt'] }).agent, null);
});

test('outside a terminal or editor there is no agent, and a browser tab says what it is', () => {
  assert.deepEqual(classify({ app: 'chrome', title: 'Inbox (3) - Gmail - Google Chrome', procs: ['claude.exe'] }), { kind: 'email', agent: null, confidence: null });
  assert.equal(classify({ app: 'msedge', title: 'general | Slack' }).kind, 'chat');
  assert.equal(classify({ app: 'chrome', title: 'Weather' }).kind, 'browser');
  assert.equal(classify({ app: 'slack', title: 'claude-team' }).kind, 'chat');
  assert.deepEqual(classify({ app: 'mspaint', title: '' }), { kind: null, agent: null, confidence: null });
  assert.deepEqual(classify(), { kind: null, agent: null, confidence: null });
});

test('a dictation pastes only into the window it started in, judged by handle, not title', () => {
  const claude = { app: 'WindowsTerminal', title: '✳ Claude Code', hwnd: 67386 };
  assert.ok(sameWindow(claude, { ...claude, title: '· Claude Code — running tests' }), 'Claude retitled its terminal: same window');
  assert.ok(!sameWindow(claude, { app: 'WindowsTerminal', title: '✳ Claude Code', hwnd: 99001 }), 'another terminal, even with the same title');
  assert.ok(!sameWindow(claude, { app: 'chrome', title: 'Inbox', hwnd: 5120 }));
  assert.ok(sameWindow(null, claude) && sameWindow(claude, null), "can't tell (not Windows, too slow): paste as before");
});
