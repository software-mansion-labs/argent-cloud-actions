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

/// The credential `acquire` logs in with, from its two mutually exclusive
/// inputs. An API key logs in as the user it belongs to; a label logs in as
/// this workflow, with the id token GitHub mints for the job. Empty is how
/// an omitted `with:` entry arrives, so empty means not given.
function credential({ apiKey, label }) {
  if (apiKey && label) {
    throw new Error(
      'api-key and label are exclusive — an API key logs in as its user, a label ' +
        'logs in as this workflow with its OIDC id token; give one or the other',
    );
  }
  if (apiKey) return { kind: 'api-key', apiKey };
  if (label) return { kind: 'workflow', label };
  throw new Error(
    'one of api-key or label is required: an API key secret, or the label this ' +
      'workflow is registered under to log in with its OIDC id token',
  );
}

/// Whether the job can request an OIDC id token: GitHub sets both variables
/// only when the job has `permissions: id-token: write`. Checked before the
/// login so a job missing the permission is told what to add, rather than
/// what the CLI could not fetch.
function idTokenAvailable(env) {
  return Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

/// Arguments for the `sim-remote login` that presents `credential`. An API
/// key travels in the environment (see childEnv), never in argv; a label is
/// not a secret and names the registration the job logs in under.
function loginArgs(credential) {
  const args = ['login', '--no-acquire'];
  if (credential.kind === 'workflow') args.push('--oidc', '--as', credential.label);
  return args;
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
///
/// Only an API-key credential adds anything: a workflow login's id token is
/// requested by the CLI itself from the job's `ACTIONS_ID_TOKEN_REQUEST_*`
/// variables, which are inherited with the rest of the environment.
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
  credential,
  idTokenAvailable,
  loginArgs,
  boolInput,
  input,
  installDir,
  intInput,
  targetTriple,
};
