import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { buildCodeArgs, resolveCodeBinary } from '../lib/tools/code.js';

test('buildCodeArgs puts the prompt last and keeps JSON output', () => {
  const args = buildCodeArgs({
    dir: 'D:/dsh_plugin/blender-harmonyos-app',
    prompt: '读取 goal brief',
    auto: true,
    model: 'deepseek/deepseek-chat',
    agent: 'build'
  });
  assert.deepEqual(args, [
    'run',
    '--dir',
    'D:/dsh_plugin/blender-harmonyos-app',
    '--format',
    'json',
    '--auto',
    '--model',
    'deepseek/deepseek-chat',
    '--agent',
    'build',
    '读取 goal brief'
  ]);
});

test('buildCodeArgs omits empty optional flags', () => {
  const args = buildCodeArgs({ dir: '/tmp/app', prompt: 'go', auto: false });
  assert.deepEqual(args, ['run', '--dir', '/tmp/app', '--format', 'json', 'go']);
});

test('resolveCodeBinary keeps an explicit path', () => {
  assert.equal(resolveCodeBinary('D:/tools/deveco.cmd'), resolve('D:/tools/deveco.cmd'));
});
