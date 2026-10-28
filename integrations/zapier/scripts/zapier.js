'use strict';

// Runs the Zapier Platform CLI release that matches zapier-platform-core in
// package.json, so nobody needs it installed globally. Run it with npm, from
// this folder, on any system:
//
//   npm run zapier -- login
//   npm run zapier -- register "AlloPlace"
//   npm run zapier -- users:links
//
// It starts the CLI through npm's own `npm exec` with this Node.js, so no
// shell reads the arguments and they reach the CLI as typed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI_PACKAGE = `zapier-platform-cli@${require('../package.json').dependencies['zapier-platform-core']}`;

// npm names its own entry point in npm_execpath for the scripts it runs.
const npmCli = () => {
  const execPath = process.env.npm_execpath || '';
  if (path.basename(execPath) !== 'npm-cli.js' || !fs.existsSync(execPath)) {
    throw new Error('Run this through npm from integrations/zapier, for example: npm run zapier -- login');
  }
  return execPath;
};

/** Runs one CLI command in this folder and returns its exit code. */
const runZapier = (args, env = process.env) => {
  const result = spawnSync(process.execPath, [npmCli(), 'exec', '--yes', `--package=${CLI_PACKAGE}`, '--', 'zapier-platform', ...args], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
};

module.exports = { CLI_PACKAGE, runZapier };

if (require.main === module) {
  try {
    process.exitCode = runZapier(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
