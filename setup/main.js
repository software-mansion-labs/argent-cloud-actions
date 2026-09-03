'use strict';

// Install the sim-remote CLI, then (when credentials are given) log in to
// sim-router and acquire a fleet machine. The machine is released by post.js
// when the job ends, so a workflow never has to remember to log out.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendCommandFile,
  appendPath,
  assetUrl,
  boolInput,
  input,
  installDir,
  intInput,
  targetTriple,
} = require('./lib.js');

/// How many times to retry the binary download. Short: a failure here is
/// GitHub's CDN hiccupping, not a queue we are waiting on.
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 3_000;

const log = (message) => console.log(message);
const group = async (title, body) => {
  console.log(`::group::${title}`);
  try {
    return await body();
  } finally {
    console.log('::endgroup::');
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Run a command, inheriting stdio so its output lands in the job log.
/// Returns the exit status rather than throwing, because the acquire retry
/// loop cares about failure without dying on it.
///
/// `quiet` buffers the output instead and prints it only on failure — for
/// runs whose success is uninteresting (the `--help` smoke check) but whose
/// failure needs explaining.
function run(command, args, { env = {}, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: quiet ? 'utf8' : 'buffer',
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  if (quiet && result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
  }
  return result.status === 0;
}

/// The download URL for the requested release asset. A public repo has a
/// stable browser URL; a private one only answers to the API, and only with a
/// token and the octet-stream Accept header.
async function resolveAssetUrl(repo, tag, target, token) {
  const name = `sim-remote-${target}`;
  if (!token) return { url: assetUrl(repo, tag, target), headers: {} };

  const api = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'argent-cloud-actions',
  };
  const response = await fetch(api, { headers });
  if (!response.ok) {
    throw new Error(`could not read release "${tag}" from ${repo}: HTTP ${response.status}`);
  }
  const release = await response.json();
  const asset = (release.assets ?? []).find((candidate) => candidate.name === name);
  if (!asset) {
    throw new Error(
      `release "${tag}" in ${repo} has no asset named ${name} — ` +
        `available: ${(release.assets ?? []).map((a) => a.name).join(', ') || '(none)'}`,
    );
  }
  return {
    url: asset.url,
    headers: { ...headers, accept: 'application/octet-stream' },
  };
}

/// Download the CLI to `destination`, executable.
async function download(url, headers, destination) {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers, redirect: 'follow' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const body = Buffer.from(await response.arrayBuffer());
      // Written under a temp name and renamed so a failed download cannot
      // leave a truncated binary that later steps would try to exec.
      const temp = `${destination}.download`;
      fs.writeFileSync(temp, body, { mode: 0o755 });
      fs.renameSync(temp, destination);
      return;
    } catch (error) {
      if (attempt === DOWNLOAD_ATTEMPTS) {
        throw new Error(`could not download ${url}: ${error.message}`);
      }
      log(`Download attempt ${attempt} failed (${error.message}); retrying...`);
      await sleep(DOWNLOAD_RETRY_DELAY_MS);
    }
  }
}

/// Environment the CLI reads its connection settings from.
///
/// SIM_ROUTER_URL is only set when non-empty: the binary has a router URL
/// baked in at build time, and an empty variable (how an unset secret arrives
/// in a workflow expression) would override it with nothing.
function routerEnv({ routerUrl, username, apiKey }) {
  const env = { SIM_ROUTER_USERNAME: username, SIM_ROUTER_API_KEY: apiKey };
  if (routerUrl) env.SIM_ROUTER_URL = routerUrl;
  return env;
}

/// Log in, then acquire a machine, retrying while the fleet is busy.
///
/// Login and acquire are separate calls (`login --no-acquire`) so that only
/// the acquire is retried: a bad credential should fail the job at once
/// instead of being retried for half an hour, and the router clamps a single
/// acquire wait to its own maximum, so a long queue is waited out by asking
/// repeatedly rather than by asking for one very long wait.
async function loginAndAcquire(cli, options) {
  const env = routerEnv(options);

  if (!run(cli, ['login', '--no-acquire'], { env })) {
    throw new Error('sim-remote login failed — check SIM_ROUTER_USERNAME / SIM_ROUTER_API_KEY');
  }
  log('Logged in to sim-router.');

  if (!options.acquire) return;

  for (let attempt = 1; attempt <= options.acquireRetries; attempt += 1) {
    if (run(cli, ['acquire', '--timeout', String(options.acquireTimeout)], { env })) {
      log('Acquired a fleet machine.');
      return;
    }
    if (attempt < options.acquireRetries) {
      log(
        `Attempt ${attempt}/${options.acquireRetries}: no fleet machine available yet, ` +
          `retrying in ${options.acquireRetryDelay}s...`,
      );
      await sleep(options.acquireRetryDelay * 1_000);
    }
  }

  throw new Error(
    `could not acquire a fleet machine after ${options.acquireRetries} attempts — ` +
      'the pool may be fully booked, or your user may have no machines assigned',
  );
}

async function main() {
  const version = input('version') || 'daily';
  const releaseRepo = input('release-repo') || 'software-mansion/sim-remote-releases';
  const token = input('token');
  const routerUrl = input('router-url');
  const username = input('username');
  const apiKey = input('api-key');

  if (apiKey) console.log(`::add-mask::${apiKey}`);

  if (Boolean(username) !== Boolean(apiKey)) {
    throw new Error('username and api-key must be given together (or both omitted to install only)');
  }

  const target = targetTriple(process.platform, process.arch);
  const dir = installDir();
  const cli = path.join(dir, 'sim-remote');

  await group(`Install sim-remote (${version}, ${target})`, async () => {
    fs.mkdirSync(dir, { recursive: true });
    const { url, headers } = await resolveAssetUrl(releaseRepo, version, target, token);
    await download(url, headers, cli);

    // Smoke check: the CLI has no --version flag, but --help exits 0 and
    // proves the binary runs on this host at all.
    if (!run(cli, ['--help'], { quiet: true })) {
      throw new Error(`${cli} does not run on this host`);
    }
    appendPath(dir);
  });

  appendCommandFile('GITHUB_OUTPUT', 'sim-remote-path', cli);
  appendCommandFile('GITHUB_OUTPUT', 'install-dir', dir);

  if (!username) {
    log('No credentials given — installed the CLI only.');
    appendCommandFile('GITHUB_OUTPUT', 'logged-in', 'false');
    return;
  }

  await loginAndAcquire(cli, {
    routerUrl,
    username,
    apiKey,
    acquire: boolInput(input('acquire'), true),
    acquireTimeout: intInput('acquire-timeout', input('acquire-timeout'), 300),
    acquireRetries: intInput('acquire-retries', input('acquire-retries'), 8),
    acquireRetryDelay: intInput('acquire-retry-delay', input('acquire-retry-delay'), 30),
  });

  appendCommandFile('GITHUB_OUTPUT', 'logged-in', 'true');
  // Read back by post.js, which cannot see this process's inputs.
  // Underscored names: the runner exposes state as `STATE_<name>` env vars,
  // and a dash there makes for an env var no shell can reference.
  appendCommandFile('GITHUB_STATE', 'sim_remote_path', cli);
  appendCommandFile('GITHUB_STATE', 'logout', String(boolInput(input('logout'), true)));
  if (routerUrl) appendCommandFile('GITHUB_STATE', 'router_url', routerUrl);
}

main().catch((error) => {
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
});
