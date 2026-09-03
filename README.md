# argent-cloud-actions

GitHub Actions for running iOS tests against **Argent Cloud** — a fleet of
remote iOS simulators driven by the [`sim-remote`][sim-remote] CLI.

A job that uses them needs no macOS runner and no Xcode: `ubuntu-latest` plus
a fleet machine is enough to install an app, drive a simulator, and run
Maestro flows. Building the `.app` still needs a Mac.

Three actions, one job each, so a workflow takes only what it needs — a lint
or tooling job can have the client without booking a machine:

| Action | What it does |
| --- | --- |
| [`install`](#install) | Fetches the `sim-remote` CLI for the runner's platform and puts it on `PATH`. |
| [`acquire`](#acquire) | Logs in, takes a fleet machine, and **releases it when the job ends**. |
| [`maestro-shims`](#maestro-shims) | Puts sim-remote's Maestro shims on `PATH`, so a stock `maestro` CLI drives the remote simulator. |

## Quickstart

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - uses: software-mansion-labs/argent-cloud-actions/install@v1

      - uses: software-mansion-labs/argent-cloud-actions/acquire@v1
        with:
          username: ${{ vars.SIM_ROUTER_USERNAME }}
          api-key: ${{ secrets.SIM_ROUTER_API_KEY }}

      # From here the CLI is on PATH and a machine is held for this job.
      - run: sim-remote simctl list devices --json
      - run: sim-remote simctl install <UDID> path/to/My.app
```

The machine is released in a post step that runs even when the job fails or is
cancelled, so a failed run does not hold a machine until its lease expires.

### Credentials

| Name | Where it goes | Notes |
| --- | --- | --- |
| `SIM_ROUTER_USERNAME` | Actions **variable** (or secret) | Your fleet user. |
| `SIM_ROUTER_API_KEY` | Actions **secret** | Never pass a literal. |
| `SIM_ROUTER_URL` | Actions secret, optional | Only for a router other than the one baked into the binary. Leave it out entirely rather than setting it empty. |

## `install`

Downloads the CLI from the release repo and adds it to `PATH`. No credentials,
no machine — a job that only needs the binary stops here.

```yaml
- uses: software-mansion-labs/argent-cloud-actions/install@v1
  id: install
  with:
    version: daily
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | `daily` | Release tag to install. `daily` is a rolling prerelease — pin a version tag for reproducible runs. |
| `release-repo` | `software-mansion/sim-remote-releases` | Repository holding the releases. |
| `token` | `''` | Token with read access to `release-repo`; only needed when it is private. |

### Outputs

| Output | Description |
| --- | --- |
| `sim-remote-path` | Absolute path of the installed CLI. |
| `install-dir` | Directory added to `PATH`. |

## `acquire`

Logs in and takes a machine from the fleet, holding it for the rest of the
job. Expects `sim-remote` on `PATH`, so it goes after `install`.

```yaml
- uses: software-mansion-labs/argent-cloud-actions/acquire@v1
  with:
    username: ${{ vars.SIM_ROUTER_USERNAME }}
    api-key: ${{ secrets.SIM_ROUTER_API_KEY }}
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `username` | — | sim-router username. Required. |
| `api-key` | — | sim-router API key. Required. |
| `router-url` | `''` | Router URL. Empty means the one baked into the binary. |
| `acquire` | `true` | Take a machine after logging in. `false` logs in only. |
| `timeout` | `300` | Seconds a single acquire waits for a free machine. |
| `retries` | `8` | How many acquire attempts before giving up. |
| `retry-delay` | `30` | Seconds between attempts. |
| `release` | `true` | Release the machine in the post step. |
| `sim-remote-path` | `''` | Path to the CLI. Defaults to `sim-remote` from `PATH`. |

### Releasing

The machine is released in a post step that runs even when the job fails or is
cancelled, so a failed run does not hold a machine until its lease expires.
That post step is the reason this is a JavaScript action: a composite action
cannot register one.

### Waiting for a machine

The fleet is a fixed pool, so a matrix of jobs will queue. Login and acquire
are separate calls: a bad credential fails immediately, while a busy pool is
waited out by retrying `acquire` — the defaults give up after
`8 × 300 s ≈ 40 minutes`. The router clamps how long a *single* acquire may
wait, which is why waiting longer means more retries, not a bigger `timeout`.

## `maestro-shims`

Maestro keeps its macOS coupling at the exec boundary — `xcrun`, `xcodebuild`,
`plutil`, `applesimutils`, `xcode-select`, `open`. `sim-remote` ships stand-ins
for all six; with them on `PATH`, the stock Maestro CLI drives a remote
simulator from Linux, unmodified.

```yaml
- uses: software-mansion-labs/argent-cloud-actions/install@v1

- uses: software-mansion-labs/argent-cloud-actions/acquire@v1
  with:
    username: ${{ vars.SIM_ROUTER_USERNAME }}
    api-key: ${{ secrets.SIM_ROUTER_API_KEY }}

- uses: software-mansion-labs/argent-cloud-actions/maestro-shims@v1

- run: maestro --udid "$UDID" test .maestro/flow.yaml
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `dir` | `${{ runner.temp }}/sim-remote-shims` | Where to write the shims. |
| `install-plistutil` | `true` | On Linux, apt-install `libplist-utils` (backs the `plutil` shim). |
| `add-to-path` | `true` | Prepend the shim directory to `PATH` for the rest of the job. |

### Outputs

| Output | Description |
| --- | --- |
| `shim-dir` | Directory the shims were written to. |

The action also exports `SIM_REMOTE_SHIM_DIR` and `SIM_REMOTE_BIN` for the
rest of the job. Note that `add-to-path: true` shadows `xcrun`, `xcodebuild`
and `open` for **every later step** — which is the point on Linux, but will
break a subsequent Xcode build on a macOS runner. Use `add-to-path: false`
there and add `$shim-dir` to `PATH` only around the Maestro step.

### Metro

A remote simulator's `localhost` is the remote host, so a Debug build that
loads JS from a Metro server on the runner needs a tunnel:

```yaml
- run: sim-remote reverse start "$UDID" 8081
```

## Runners

| Runner | Supported |
| --- | --- |
| `ubuntu-latest`, `ubuntu-*-arm` | yes |
| `macos-latest` (Apple silicon) | yes |
| Intel macOS (`macos-13`) | no — no `x86_64-apple-darwin` build is published |
| Windows | no |

## Using it from another repository

This repository is private, and GitHub only resolves a `uses:` reference to a
private action from repositories in the **same organization** — its Actions
access policy is already set to allow that, so any
`software-mansion-labs/*` workflow can reference it directly.

From outside the organization (`software-mansion/*`, for instance) a `uses:`
reference cannot work. Check the actions out and reference them by path
instead:

```yaml
- name: Check out the Argent Cloud actions
  uses: actions/checkout@v5
  with:
    repository: software-mansion-labs/argent-cloud-actions
    ref: v1
    path: .argent-cloud-actions
    token: ${{ secrets.ARGENT_ACTIONS_TOKEN }}  # read access to this repo

- uses: ./.argent-cloud-actions/install

- uses: ./.argent-cloud-actions/acquire
  with:
    username: ${{ vars.SIM_ROUTER_USERNAME }}
    api-key: ${{ secrets.SIM_ROUTER_API_KEY }}
```

## Versioning

Releases are tagged `vN.N.N`, with a moving `vN` tag. Pin `@v1` for the
actions and pin `version:` to a `sim-remote` release tag if you need runs to
be reproducible — the default `daily` is rebuilt from the latest tree.

## Development

```bash
node --test                                   # unit tests
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color
```

`install` and `acquire` run on the runner's Node 24 (`using: node24`) and are
plain Node with no dependencies, sharing
`lib/lib.js`, so there is nothing to bundle or commit into `dist/`: what runs
on the runner is what is in the repo.
`.github/workflows/e2e.yml` exercises the credentialed path against a real
fleet machine; it needs `SIM_ROUTER_USERNAME` and `SIM_ROUTER_API_KEY` in this
repository's secrets.

[sim-remote]: https://github.com/software-mansion/radon-cloud
