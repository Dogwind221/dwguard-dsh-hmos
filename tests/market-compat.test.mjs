// Real verdict matrix for the host-gate/market declarations. The previous
// test only checked the string literally; ^0.0.1 passed it even though market
// compatibility is decided by semver with prereleases included.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import semver from 'semver';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const hostPeers = new Set(['@deepseek-ai/dsh-tools']);

function marketCompatible(host, manifest = pkg) {
  const engine = manifest.engines?.dsh;
  if (typeof engine !== 'string') return false;
  if (!semver.satisfies(host, engine, { includePrerelease: true })) return false;
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!hostPeers.has(name) || !name.startsWith('@deepseek-ai/dsh')) continue;
    if (!semver.satisfies(host, range, { includePrerelease: true })) return false;
  }
  return true;
}

test('0.9.1 manifest verdicts match the real host gate/market matrix', () => {
  assert.equal(marketCompatible('0.2.1-rc.5'), true);
  assert.equal(marketCompatible('0.2.2-rc.1'), true);
  assert.equal(marketCompatible('0.1.2'), false);
  assert.equal(marketCompatible('0.3.0-rc.1'), false);
});

test('old exact dsh-tools pin is incompatible on 0.2.2-rc.1', () => {
  const old = { ...pkg, peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/dsh-tools': '0.2.1-rc.5' } };
  assert.equal(marketCompatible('0.2.2-rc.1', old), false);
});

test('the caret is stricter than a handwritten <0.3.0 peer range', () => {
  const handwritten = { ...pkg, peerDependencies: { ...pkg.peerDependencies, '@deepseek-ai/dsh-tools': '>=0.2.1-rc.5 <0.3.0' } };
  assert.equal(marketCompatible('0.3.0-rc.1', handwritten), true);
  assert.equal(marketCompatible('0.3.0-rc.1'), false);
});

test('the 0.2.2 peer pair is declared as a union, not a 4.0/3.18-only pin', () => {
  assert.match(pkg.peerDependencies['@deepseek-ai/cordis'], /~4\.0\.5 \|\| ~4\.1\.0/);
  assert.match(pkg.peerDependencies['@deepseek-ai/schemastery'], /~3\.18\.5 \|\| ~3\.19\.0/);
  assert.equal(pkg.devDependencies['@deepseek-ai/dsh-tools'], '0.2.2-rc.1');
});
