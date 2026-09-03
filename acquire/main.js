'use strict';

// Log in to sim-router and take a machine from the fleet, then hold it for
// the rest of the job. post.js releases it — see the note there on why this
// is a JavaScript action.
//
// Installing the CLI is the install action's job; this one expects
// `sim-remote` to already be on PATH.

const { spawnSync } = require('node:child_process');

const { appendCommandFile, boolInput, childEnv, input, intInput } = require('../lib/lib.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Run a command, inheriting stdio so its output lands in the job log.
/// Returns whether it succeeded rather than throwing, because the acquire
/// retry loop cares about failure without dying on it.
///
/// `env` is the child's complete environment, not an overlay on this
/// process's: childEnv() removes variables as well as adding them, and
/// merging `process.env` back in here would undo the removals.
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  return result.status === 0;
}

/// Resolve the CLI to drive: an explicit path if given, else whatever
/// `sim-remote` PATH resolves to. Checked here so a missing install action
/// is reported as such, rather than as an ENOENT from the login call.
function resolveCli() {
  const explicit = input('sim-remote-path');
  if (explicit) return explicit;

  const found = spawnSync('sim-remote', ['--help'], { stdio: 'ignore' });
  if (found.error) {
    throw new Error(
      'sim-remote is not on PATH — run the install action first, or pass sim-remote-path',
    );
  }
  return 'sim-remote';
}

/// Log in, then acquire a machine, retrying while the fleet is busy.
///
/// Login and acquire are separate calls (`login --no-acquire`) so that only
/// the acquire is retried: a bad credential should fail the job at once
/// instead of being retried for half an hour, and the router clamps a single
/// acquire wait to its own maximum, so a long queue is waited out by asking
/// repeatedly rather than by asking for one very long wait.
async function loginAndAcquire(cli, options) {
  const env = childEnv(process.env, options);

  if (!run(cli, ['login', '--no-acquire'], env)) {
    throw new Error('sim-remote login failed — check SIM_ROUTER_USERNAME / SIM_ROUTER_API_KEY');
  }
  console.log('Logged in to sim-router.');

  if (!options.acquire) {
    console.log('acquire: false — logged in without taking a machine.');
    return;
  }

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    if (run(cli, ['acquire', '--timeout', String(options.timeout)], env)) {
      console.log('Acquired a fleet machine.');
      return;
    }
    if (attempt < options.retries) {
      console.log(
        `Attempt ${attempt}/${options.retries}: no fleet machine available yet, ` +
          `retrying in ${options.retryDelay}s...`,
      );
      await sleep(options.retryDelay * 1_000);
    }
  }

  throw new Error(
    `could not acquire a fleet machine after ${options.retries} attempts — ` +
      'the pool may be fully booked, or your user may have no machines assigned',
  );
}

async function main() {
  const username = input('username');
  const apiKey = input('api-key');
  const routerUrl = input('router-url');

  if (apiKey) console.log(`::add-mask::${apiKey}`);
  if (!username || !apiKey) {
    throw new Error('username and api-key are required');
  }

  const cli = resolveCli();

  await loginAndAcquire(cli, {
    routerUrl,
    username,
    apiKey,
    acquire: boolInput(input('acquire'), true),
    timeout: intInput('timeout', input('timeout'), 300),
    retries: intInput('retries', input('retries'), 8),
    retryDelay: intInput('retry-delay', input('retry-delay'), 30),
  });

  // Read back by post.js, which cannot see this process's inputs.
  // Underscored names: the runner exposes state as `STATE_<name>` env vars,
  // and a dash there makes for an env var no shell can reference.
  appendCommandFile('GITHUB_STATE', 'sim_remote_path', cli);
  appendCommandFile('GITHUB_STATE', 'release', String(boolInput(input('release'), true)));
  if (routerUrl) appendCommandFile('GITHUB_STATE', 'router_url', routerUrl);
}

main().catch((error) => {
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
});
