#!/usr/bin/env node
'use strict';
// The `axo` command: `axo <agent> [arguments for it]`. It only picks the
// agent's launcher; the launcher does the work (agents/<agent>/launched/).
const LAUNCHERS = { claude: '../agents/claude/launched/launcher' };

const [agent, ...args] = process.argv.slice(2);
if (!LAUNCHERS[agent]) {
  console.error('usage: axo claude [arguments for claude]');
  process.exit(2);
}
require(LAUNCHERS[agent]).run(args);
