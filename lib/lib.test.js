'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { assetUrl, boolInput, childEnv, input, intInput, targetTriple } = require('./lib.js');

describe('targetTriple', () => {
  it('maps the runners we support onto published assets', () => {
    assert.equal(targetTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
    assert.equal(targetTriple('linux', 'x64'), 'x86_64-unknown-linux-gnu');
    assert.equal(targetTriple('linux', 'arm64'), 'aarch64-unknown-linux-gnu');
  });

  // An Intel macOS runner is the plausible mistake: `macos-13` is still
  // offered, and no x86_64-apple-darwin asset is published.
  it('fails on platforms with no published build', () => {
    assert.throws(() => targetTriple('darwin', 'x64'), /no sim-remote build for darwin\/x64/);
    assert.throws(() => targetTriple('win32', 'x64'), /no sim-remote build for win32\/x64/);
  });
});

describe('assetUrl', () => {
  it('points at the latest release asset', () => {
    assert.equal(
      assetUrl('https://github.com/software-mansion/sim-remote-releases/releases', 'x86_64-unknown-linux-gnu'),
      'https://github.com/software-mansion/sim-remote-releases/releases/latest/download/sim-remote-x86_64-unknown-linux-gnu',
    );
  });

  it('tolerates a trailing slash on the releases URL', () => {
    assert.equal(assetUrl('https://example.com/releases/', 'x'), 'https://example.com/releases/latest/download/sim-remote-x');
  });
});

describe('boolInput', () => {
  it('accepts the spellings a workflow author reaches for', () => {
    for (const value of ['true', 'TRUE', ' yes ', '1']) {
      assert.equal(boolInput(value, false), true, value);
    }
    for (const value of ['false', 'No', '0']) {
      assert.equal(boolInput(value, true), false, value);
    }
  });

  // An omitted `with:` entry and one whose expression evaluated to nothing
  // both arrive as an empty string, and must not read as false.
  it('treats unset and empty as the default', () => {
    assert.equal(boolInput(undefined, true), true);
    assert.equal(boolInput('', true), true);
  });

  it('rejects a value it cannot interpret', () => {
    assert.throws(() => boolInput('maybe', true), /expected a boolean/);
  });
});

describe('intInput', () => {
  it('parses integers and falls back on empty', () => {
    assert.equal(intInput('acquire-retries', '12', 8), 12);
    assert.equal(intInput('acquire-retries', '', 8), 8);
  });

  it('rejects non-integers and negatives', () => {
    assert.throws(() => intInput('acquire-timeout', '5.5', 300), /non-negative integer/);
    assert.throws(() => intInput('acquire-timeout', '-1', 300), /non-negative integer/);
    assert.throws(() => intInput('acquire-timeout', 'soon', 300), /non-negative integer/);
  });
});

describe('input', () => {
  // The runner uppercases the input name and turns spaces into underscores,
  // but leaves dashes alone — so `api-key` arrives as `INPUT_API-KEY`.
  it('reads the INPUT_* variables the runner sets', (t) => {
    t.after(() => {
      delete process.env['INPUT_API-KEY'];
      delete process.env.INPUT_ACQUIRE_RETRY_DELAY;
    });
    process.env['INPUT_API-KEY'] = '  secret  ';
    process.env.INPUT_ACQUIRE_RETRY_DELAY = '15';

    assert.equal(input('api-key'), 'secret');
    assert.equal(input('acquire retry delay'), '15');
    assert.equal(input('never-set'), '');
  });
});

describe('childEnv', () => {
  it('keeps the rest of the environment', () => {
    const env = childEnv({ PATH: '/bin' }, {});
    assert.equal(env.PATH, '/bin');
  });

  // The bug this guards: `SIM_ROUTER_URL: ${{ secrets.SIM_ROUTER_URL }}` on a
  // job whose secret is not set puts an empty string in the environment, and
  // clap reads set-but-empty as a value — overriding the URL baked into the
  // binary with nothing, which fails to connect as "builder error".
  it('removes an empty inherited SIM_ROUTER_URL', () => {
    const env = childEnv({ SIM_ROUTER_URL: '' }, {});
    assert.ok(!('SIM_ROUTER_URL' in env));
  });

  // The baked-in router is the only one; a stray override is dropped too.
  it('removes a non-empty inherited SIM_ROUTER_URL', () => {
    const env = childEnv({ SIM_ROUTER_URL: 'https://elsewhere' }, {});
    assert.ok(!('SIM_ROUTER_URL' in env));
  });

  it('sets credentials only when given', () => {
    const withCreds = childEnv({}, { apiKey: 'k' });
    assert.equal(withCreds.SIM_ROUTER_API_KEY, 'k');

    // post.js logs out without it; it must not appear as "undefined".
    const withoutCreds = childEnv({});
    assert.ok(!('SIM_ROUTER_API_KEY' in withoutCreds));
  });

  it('does not mutate the environment it was given', () => {
    const base = { SIM_ROUTER_URL: '' };
    childEnv(base, {});
    assert.equal(base.SIM_ROUTER_URL, '');
  });
});
