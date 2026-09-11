'use strict';

// Install the sim-remote CLI onto the runner's PATH. Logging in and taking a
// fleet machine is the acquire action's job — a workflow that only needs the
// CLI (to talk to a machine it already holds, or to read `--help` in a lint
// job) should not book a machine to get one.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  appendCommandFile,
  appendPath,
  DEFAULT_RELEASES_URL,
  assetUrl,
  input,
  installDir,
  targetTriple,
} = require('../lib/lib.js');

/// How many times to retry the binary download. Short: a failure here is
/// GitHub's CDN hiccupping, not a queue we are waiting on.
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 3_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Download the CLI to `destination`, executable.
async function download(url, destination) {
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
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
      console.log(`Download attempt ${attempt} failed (${error.message}); retrying...`);
      await sleep(DOWNLOAD_RETRY_DELAY_MS);
    }
  }
}

async function main() {
  const releasesUrl = input('releases-url') || DEFAULT_RELEASES_URL;

  const target = targetTriple(process.platform, process.arch);
  const dir = installDir();
  const cli = path.join(dir, 'sim-remote');

  console.log(`::group::Install sim-remote (latest release, ${target})`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await download(assetUrl(releasesUrl, target), cli);

    // Smoke check: the CLI has no --version flag, but --help exits 0 and
    // proves the binary runs on this host at all. Its output is buffered and
    // printed only on failure, where it is the explanation.
    const smoke = spawnSync(cli, ['--help'], { encoding: 'utf8' });
    if (smoke.error) throw smoke.error;
    if (smoke.status !== 0) {
      process.stdout.write(smoke.stdout ?? '');
      process.stderr.write(smoke.stderr ?? '');
      throw new Error(`${cli} does not run on this host`);
    }

    appendPath(dir);
  } finally {
    console.log('::endgroup::');
  }

  console.log(`Installed sim-remote to ${cli}`);
  appendCommandFile('GITHUB_OUTPUT', 'sim-remote-path', cli);
  appendCommandFile('GITHUB_OUTPUT', 'install-dir', dir);
}

main().catch((error) => {
  console.log(`::error::${error.message}`);
  process.exitCode = 1;
});
