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

      - uses: software-mansion-labs/argent-cloud-actions/install@v2

      - uses: software-mansion-labs/argent-cloud-actions/acquire@v2
        with:
          api-key: ${{ secrets.SIM_ROUTER_API_KEY }}

      # From here the CLI is on PATH and a machine is held for this job.
      - run: sim-remote simctl list devices --json
      - run: sim-remote simctl install <UDID> path/to/My.app
```

The machine is released in a post step that runs even when the job fails or is
cancelled, so a failed run does not hold a machine until its lease expires.

### Credentials

`acquire` logs in one of two ways:

| Input | Where the value comes from | Notes |
| --- | --- | --- |
| `api-key` | An Actions **secret** (`SIM_ROUTER_API_KEY`) | Logs in as the user the key belongs to. Never pass a literal. |
| `label` | The registration of this workflow on the router | Logs in **as the workflow**, with the OIDC id token GitHub mints for the job. No secret anywhere. |

### Logging in as the workflow

A job can log in with no stored secret at all. It presents the OIDC id token
GitHub issues to it, which says which repository and workflow file it is
running, and the router admits it if an administrator has registered that
workflow for your tenant under a **label** — the name the job logs in under.
Ask for the registration (it names the repository, the workflow file and the
label; it can be narrowed to branches or deployment environments), then grant
the job an id token and quote the label:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write   # without this GitHub mints no token and the action says so

    steps:
      - uses: software-mansion-labs/argent-cloud-actions/install@v2
      - uses: software-mansion-labs/argent-cloud-actions/acquire@v2
        with:
          label: my-app-e2e
```

Each job is its own user, `<label>+<run_id>.<run_attempt>.<id>`, so matrix
legs of one run hold separate machines and cannot release each other's. The
rule matches the *calling* workflow file: a job in a reusable workflow logs in
as the workflow that called it, and that caller must grant `id-token: write`
too, since a called workflow can only narrow its caller's permissions. A
`pull_request` run from a fork gets no id token.

### Secret handling

When an API key is used, `api-key` **must** come from `secrets.*`. The runner echoes a step's whole
`with:` block into the log, and the only thing that redacts a value there is
GitHub's automatic masking of registered secrets — so a key passed from
`vars.*` or as a literal is printed in plaintext, and the action's own
`::add-mask::` cannot help, because the header is written before the action
starts. Passing it through `env:` instead of `with:` changes nothing: that
block is echoed too.

Given a secret, the key stays contained:

* it reaches the CLI as an environment variable, never as an argument, so it
  is not visible in `ps` to anything else on the runner;
* it is never written to `GITHUB_ENV`, `GITHUB_OUTPUT` or `GITHUB_STATE`, so
  it does not reach later steps — the post step is handed only the CLI path;
* `sim-remote login` exchanges it for a session token kept in the daemon's
  memory, and neither is written to disk, so a `$HOME` cache or an artifact
  upload cannot carry it out of the job.

Later steps use the daemon's session rather than the credential, which is why
only `acquire` needs it.

## `install`

Downloads the latest published release of the CLI and adds it to `PATH`. No
credentials, no machine — a job that only needs the binary stops here.

```yaml
- uses: software-mansion-labs/argent-cloud-actions/install@v2
  id: install
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `releases-url` | `https://github.com/software-mansion/sim-remote-releases/releases` | Where the releases are published. The binary comes from `<releases-url>/latest/download/sim-remote-<target>`. |

### Outputs

| Output | Description |
| --- | --- |
| `sim-remote-path` | Absolute path of the installed CLI. |
| `install-dir` | Directory added to `PATH`. |

## `acquire`

Logs in and takes a machine from the fleet, holding it for the rest of the
job. Expects `sim-remote` on `PATH`, so it goes after `install`.

```yaml
- uses: software-mansion-labs/argent-cloud-actions/acquire@v2
  with:
    api-key: ${{ secrets.SIM_ROUTER_API_KEY }}
```

or, as the workflow (see [Logging in as the workflow](#logging-in-as-the-workflow)):

```yaml
- uses: software-mansion-labs/argent-cloud-actions/acquire@v2
  with:
    label: my-app-e2e
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | `''` | sim-router API key. Exactly one of `api-key` and `label`. |
| `label` | `''` | Log in as this workflow, with the job's OIDC id token, under the label it is registered with on the router. Needs `permissions: id-token: write`. Exactly one of `api-key` and `label`. |
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

### The router URL

The router URL is baked into the `sim-remote` binary and there is no input to
override it. A `SIM_ROUTER_URL` in the job environment is not forwarded to the
CLI either: the CLI counts a set-but-empty variable as a value, so a leftover
`SIM_ROUTER_URL: ${{ secrets.SIM_ROUTER_URL }}` line whose secret is unset
would otherwise override the baked-in URL with nothing and fail to connect.

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
- uses: software-mansion-labs/argent-cloud-actions/install@v2

- uses: software-mansion-labs/argent-cloud-actions/acquire@v2
  with:
    api-key: ${{ secrets.SIM_ROUTER_API_KEY }}

- uses: software-mansion-labs/argent-cloud-actions/maestro-shims@v2

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

This repository is public, so a workflow in any repository can reference the
actions with `uses:` directly; nothing needs checking out.

## Versioning

Releases are tagged `vN.N.N`, with a moving `vN` tag. Pin `@v2` for the
actions. `v2` differs from `v1` in that `install` takes no `version`,
`release-repo` or `token` (it always fetches the latest published release),
`acquire` takes no `username` or `router-url` (the key identifies the user and
the router is the baked-in one), and `acquire` can log in as the workflow with
`label` instead of an `api-key`. The `install` action always fetches the latest published `sim-remote`
release; point `releases-url` elsewhere to install from a different set of
releases.

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
fleet machine; it needs `SIM_ROUTER_API_KEY` in this repository's secrets.

[sim-remote]: https://github.com/software-mansion/radon-cloud
