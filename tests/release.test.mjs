// Release helper: semantic version bump is pure and testable.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bumpVersion } from '../scripts/release.mjs';

test('bumpVersion handles patch / minor / major', () => {
  assert.equal(bumpVersion('0.2.0', 'patch'), '0.2.1');
  assert.equal(bumpVersion('0.2.9', 'minor'), '0.3.0');
  assert.equal(bumpVersion('1.9.9', 'major'), '2.0.0');
});

test('bumpVersion rejects malformed input', () => {
  assert.throws(() => bumpVersion('0.2', 'patch'), /invalid version/);
  assert.throws(() => bumpVersion('0.2.0', 'beta'), /invalid bump/);
});
