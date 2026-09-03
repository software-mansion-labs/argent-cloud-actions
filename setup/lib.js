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

/// Download URL for a release asset in a *public* repo. Private repos go
/// through the API instead (see resolveAssetUrl in main.js), because a browser
/// download URL is not authenticated.
function assetUrl(repo, tag, target) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/sim-remote-${target}`;
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
  TARGETS,
  appendCommandFile,
  appendPath,
  assetUrl,
  boolInput,
  input,
  installDir,
  intInput,
  targetTriple,
};
