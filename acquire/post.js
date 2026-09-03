'use strict';

// Release the fleet machine when the job ends.
//
// This is why acquiring is a JavaScript action rather than a composite one:
// only a JavaScript action can register a post step, and a machine that is
// not released stays booked until the router's lease expires — blocking every
// other job in the pool, including retries of this one.

const { spawnSync } = require('node:child_process');

const cli = process.env.STATE_sim_remote_path;
const shouldRelease = (process.env.STATE_release ?? 'true') !== 'false';
const routerUrl = process.env.STATE_router_url;

if (!cli) {
  // main.js never got as far as logging in, so there is nothing to release.
  process.exit(0);
}

if (!shouldRelease) {
  console.log('release: false — leaving the session logged in.');
  process.exit(0);
}

const env = { ...process.env };
if (routerUrl) env.SIM_ROUTER_URL = routerUrl;

const result = spawnSync(cli, ['logout'], { stdio: 'inherit', env });

// A failed logout must not fail an otherwise green job: the lease expires on
// its own, and the run's real result is whatever the test steps said.
if (result.status !== 0) {
  console.log(
    '::warning::sim-remote logout failed — the machine will be released when its lease expires',
  );
}
