// Screenshot diff (1.0.5): identical images pass, changed pixels fail, and
// dimension mismatch is reported without inventing pixel numbers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffImages, encodePng } from '../lib/imageDiff.js';

function solid(width, height, rgba) {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buffer[i * 4] = rgba[0];
    buffer[i * 4 + 1] = rgba[1];
    buffer[i * 4 + 2] = rgba[2];
    buffer[i * 4 + 3] = rgba[3];
  }
  return buffer;
}

test('identical screenshots pass with zero changed pixels', () => {
  const png = encodePng(8, 8, solid(8, 8, [30, 120, 200, 255]));
  const { result, diffPng } = diffImages(png, png);
  assert.equal(result.pass, true);
  assert.equal(result.changedPixels, 0);
  assert.equal(result.changedRatio, 0);
  assert.equal(result.phashDistance, 0);
  assert.ok(diffPng !== null);
});

test('a changed block fails the diff and reports a region', () => {
  const baseline = solid(16, 16, [20, 20, 20, 255]);
  const current = Buffer.from(baseline);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const index = (y * 16 + x) * 4;
      current[index] = 240;
      current[index + 1] = 240;
      current[index + 2] = 240;
    }
  }
  const { result, diffPng } = diffImages(encodePng(16, 16, baseline), encodePng(16, 16, current));
  assert.equal(result.pass, false);
  assert.ok(result.changedPixels > 0);
  assert.ok(result.changedRatio > 0.2);
  assert.ok(result.regions.length > 0);
  assert.ok(diffPng !== null);
});

test('dimension mismatch is reported and pixel metrics stay zero', () => {
  const first = encodePng(8, 8, solid(8, 8, [10, 10, 10, 255]));
  const second = encodePng(10, 8, solid(10, 8, [10, 10, 10, 255]));
  const { result } = diffImages(first, second);
  assert.equal(result.dimensionMismatch, true);
  assert.equal(result.totalPixels, 0);
  assert.equal(result.pass, false);
});
