#!/usr/bin/env node
/**
 * Test preflight: the tests load the built `lib/` against the real host packages
 * (`defineTool` from `@deepseek-ai/dsh-tools`, `schemastery` from config). When
 * they are missing, print the exact install command instead of an
 * `ERR_MODULE_NOT_FOUND` stack from deep inside `lib/config.js`.
 *
 * `npm install` installs both because they are devDependencies; this script is
 * the guard for anyone who installed with `--no-save` or linked a host tree.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const REQUIRED = [
  { name: '@deepseek-ai/dsh-tools', version: '0.2.1-rc.5' },
  { name: '@deepseek-ai/schemastery', version: '3.18.5' }
];

const missing = [];
for (const entry of REQUIRED) {
  try {
    require.resolve(entry.name);
  } catch {
    missing.push(entry);
  }
}

if (missing.length === 0) process.exit(0);

const install = missing.map((entry) => `${entry.name}@${entry.version}`).join(' ');
console.error(
  [
    '',
    `[dwguard] 缺少测试所需的宿主包：${missing.map((entry) => entry.name).join('、')}`,
    '',
    '  在仓库根目录执行（二选一）：',
    '    npm install                 # devDependencies 已包含它们',
    `    npm install --no-save ${install}`,
    '',
    '  说明：测试会调用真实的 `defineTool`，所以不能只有类型声明。',
    ''
  ].join('\n')
);
process.exit(1);
