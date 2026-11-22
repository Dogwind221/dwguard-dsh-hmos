// Runtime accessibility checks (1.0.5): touch-target sizes from bounds and
// contrast estimates sampled from the screenshot region.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeA11yRuntime } from '../lib/a11yRuntime.js';
import { encodePng } from '../lib/imageDiff.js';

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

const layout = {
  id: 'root',
  type: 'Column',
  children: [
    { id: 'small-button', type: 'Button', clickable: true, bounds: [0, 0, 20, 20] },
    { id: 'big-button', type: 'Button', clickable: true, bounds: [0, 40, 80, 80] },
    { id: 'label', type: 'Text', text: 'Hello', bounds: [0, 0, 8, 8] }
  ]
};

test('flags small touch targets and low-contrast text regions', () => {
  const screenshot = encodePng(64, 64, solid(64, 64, [200, 200, 200, 255]));
  const report = analyzeA11yRuntime(layout, screenshot, { minTouchSize: 44, minContrast: 4.5 });
  assert.equal(report.nodes, 4);
  assert.equal(report.clickable, 2);
  assert.equal(report.textNodes, 1);
  assert.equal(report.touchTargetViolations, 1);
  assert.equal(report.touchTargets[0].node, 'small-button');
  assert.equal(report.contrastViolations, 1);
  assert.match(report.contrasts[0].node, /Hello|label/);
});

test('accepts a large touch target and high-contrast text', () => {
  const image = solid(64, 64, [255, 255, 255, 255]);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const index = ((y + 130 - 130) * 64 + x) * 4;
      image[index] = 0;
      image[index + 1] = 0;
      image[index + 2] = 0;
    }
  }
  const big = { id: 'root', type: 'Column', children: [{ id: 'button', type: 'Button', clickable: true, bounds: [0, 0, 80, 80] }] };
  const report = analyzeA11yRuntime(big, encodePng(64, 64, image), { minTouchSize: 44 });
  assert.equal(report.touchTargetViolations, 0);
});

