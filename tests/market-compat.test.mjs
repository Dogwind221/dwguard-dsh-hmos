// Regression guard: DSH Market compares @deepseek-ai/dsh-* peers against the
// running host version. An exact 0.2.1-rc.5 pin is "aboveMax" on 0.2.2-rc.1
// and hides the plugin as incompatible.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('dsh-tools peer is a host-line range, not an exact pin', () => {
  const range = pkg.peerDependencies?.['@deepseek-ai/dsh-tools'];
  assert.equal(typeof range, 'string');
  assert.notEqual(range, '0.2.1-rc.5');
  assert.match(range, /^(?:\^|~|>=)/);
});

test('engines.dsh covers the current 0.2.x host line', () => {
  assert.match(pkg.engines?.dsh ?? '', /0\.2\.1-rc\.0/);
  assert.match(pkg.engines?.dsh ?? '', /0\.3\.0/);
});
