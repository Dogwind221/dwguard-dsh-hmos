// Release helper: semantic version bump and README version sync are pure and testable.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bumpVersion, syncLockVersion, syncVersionText } from '../scripts/release.mjs';

test('bumpVersion handles patch / minor / major', () => {
  assert.equal(bumpVersion('0.2.0', 'patch'), '0.2.1');
  assert.equal(bumpVersion('0.2.9', 'minor'), '0.3.0');
  assert.equal(bumpVersion('1.9.9', 'major'), '2.0.0');
});

test('bumpVersion rejects malformed input', () => {
  assert.throws(() => bumpVersion('0.2', 'patch'), /invalid version/);
  assert.throws(() => bumpVersion('0.2.0', 'beta'), /invalid bump/);
});

test('syncLockVersion updates the root version fields without touching dependencies', () => {
  const lock = {
    version: '0.6.1',
    packages: {
      '': { name: 'dwguard-dsh-hmos', version: '0.6.1' },
      'node_modules/dep': { version: '1.2.3' }
    }
  };
  const next = syncLockVersion(lock, '0.6.2');
  assert.equal(next.version, '0.6.2');
  assert.equal(next.packages[''].version, '0.6.2');
  assert.equal(next.packages['node_modules/dep'].version, '1.2.3');
  assert.equal(lock.version, '0.6.1', '输入对象不得被原地修改');
  assert.throws(() => syncLockVersion(lock, '0.6'), /invalid version/);
});

test('syncVersionText rewrites the Chinese install pins and release command', () => {
  const before = [
    '已发布到 npm：[`dwguard-dsh-hmos`](https://www.npmjs.com/package/dwguard-dsh-hmos)（当前 0.4.2）。',
    '2. 包名填 `dwguard-dsh-hmos`（固定版本就填 `dwguard-dsh-hmos@0.4.2`）',
    'dsh plugin --profile web add dwguard-dsh-hmos@0.4.1',
    '`git tag v0.4.2 && git push origin v0.4.2`'
  ].join('\n');
  const after = syncVersionText(before, '0.6.1', 'zh');
  assert.match(after, /（当前 0\.6\.1）/);
  assert.match(after, /dwguard-dsh-hmos@0\.6\.1`/);
  assert.match(after, /add dwguard-dsh-hmos@0\.6\.1/);
  assert.match(after, /git tag v0\.6\.1 && git push origin v0\.6\.1/);
  assert.doesNotMatch(after, /0\.4\.[12]/);
});

test('syncVersionText rewrites the English install pins', () => {
  const before = [
    'Published on npm: dwguard-dsh-hmos (current 0.4.2).',
    'the package name `dwguard-dsh-hmos` (pin a version with `dwguard-dsh-hmos@0.4.2`)',
    'dsh plugin --profile web add dwguard-dsh-hmos@0.4.1   # pin a version'
  ].join('\n');
  const after = syncVersionText(before, '0.6.1', 'en');
  assert.match(after, /\(current 0\.6\.1\)/);
  assert.equal((after.match(/dwguard-dsh-hmos@0\.6\.1/g) ?? []).length, 2);
  assert.doesNotMatch(after, /0\.4\.[12]/);
});

test('syncVersionText is idempotent and rejects a bad version', () => {
  const once = syncVersionText('（当前 0.4.2）· dwguard-dsh-hmos@0.4.2', '0.6.1', 'zh');
  assert.equal(syncVersionText(once, '0.6.1', 'zh'), once);
  assert.throws(() => syncVersionText('x', '0.6', 'zh'), /invalid version/);
});
