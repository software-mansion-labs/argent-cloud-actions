'use strict';

// Pure helpers for the setup action. Kept apart from main.js so they can be
// unit-tested with `node --test`, which the action's own I/O cannot be.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/// Release assets are named `sim-remote-<target>`, where <target> is the Rust
/// target triple the binary was built for. Only the triples the release
/// workflow actually publishes are listed: an x86_64 Mac has no build, and
/// saying so beats a 404 from the download.
const TARGETS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

/// Rust target triple for a Node `process.platform`/`process.arch` pair.
function targetTriple(platform, arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) {
    throw new Error(
      `no sim-remote build for ${platform}/${arch} — supported runners are ` +
        `${Object.keys(TARGETS).join(', ')}`,
    );
  }
  return target;
}

/// Where sim-remote releases are published, unless the action is told
/// otherwise.
const DEFAULT_RELEASES_URL = 'https://github.com/software-mansion/sim-remote-releases/releases';

/// Download URL for the asset of the *latest* published release. GitHub's
/// `latest/download` path redirects to the newest non-prerelease, so nothing
/// here needs to know a tag.
function assetUrl(releasesUrl, target) {
  return `${releasesUrl.replace(/\/+$/, '')}/latest/download/sim-remote-${target}`;
}

/// Parse a GitHub Actions boolean input. Unset (or empty, which is how an
/// unset expression arrives) falls back to `fallback`.
function boolInput(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 'yes', '1'].includes(normalized)) return true;
  if (['false', 'no', '0'].includes(normalized)) return false;
  throw new Error(`expected a boolean ("true" or "false"), got "${value}"`);
}

/// Parse a positive-integer input, with the same empty-means-unset rule.
function intInput(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

/// Read an action input the way `@actions/core` does, so the action needs no
/// dependencies: the runner passes `with:` entries as INPUT_* env vars, with
/// spaces turned into underscores.
function input(name) {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return value === undefined ? '' : value.trim();
}

/// Append a `key=value` line to one of the runner's command files
/// (GITHUB_ENV, GITHUB_OUTPUT, GITHUB_STATE). Values are written in the
/// heredoc form so a multi-line or `=`-containing value cannot be misparsed.
function appendCommandFile(fileEnvVar, key, value) {
  const file = process.env[fileEnvVar];
  if (!file) return; // not running under the Actions runner (e.g. local test)
  const delimiter = `ghadelimiter_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(file, `${key}<<${delimiter}${os.EOL}${value}${os.EOL}${delimiter}${os.EOL}`);
}

/// Environment for a sim-remote child process, given the environment this
/// process runs in.
///
/// The router URL is baked into the binary and is the only one the actions
/// talk to, so `SIM_ROUTER_URL` is never forwarded. That matters for the
/// empty case in particular: clap counts a set-but-empty variable as a value,
/// so an empty `SIM_ROUTER_URL` — which is what a job inherits from a
/// `SIM_ROUTER_URL: ${{ secrets.SIM_ROUTER_URL }}` line whose secret is not
/// configured — would override the baked-in URL with nothing and fail with a
/// bare "builder error".
function childEnv(baseEnv, { apiKey } = {}) {
  const env = { ...baseEnv };

  if (apiKey !== undefined) env.SIM_ROUTER_API_KEY = apiKey;
  delete env.SIM_ROUTER_URL;

  return env;
}

/// Append a line to GITHUB_PATH, which is a plain list of directories rather
/// than the key=value command files above.
function appendPath(dir) {
  const file = process.env.GITHUB_PATH;
  if (!file) return;
  fs.appendFileSync(file, `${dir}${os.EOL}`);
}

/// Where the CLI is installed. `~/.local/bin` rather than a temp directory:
/// it survives for the whole job, is already on PATH in many images, and is
/// where a developer reproducing the workflow by hand would put it.
function installDir() {
  return path.join(os.homedir(), '.local', 'bin');
}

module.exports = {
  DEFAULT_RELEASES_URL,
  TARGETS,
  appendCommandFile,
  appendPath,
  assetUrl,
  childEnv,
  boolInput,
  input,
  installDir,
  intInput,
  targetTriple,
};
