#!/usr/bin/env node
/**
 * Release-content gate (0.8.6).
 *
 * Run after `npm run build`/`npm test` and before `npm publish`. It verifies:
 *   - a tag (when supplied/available) matches package.json.version;
 *   - the npm pack file list still contains the runtime assets;
 *   - the release includes the built `lib/` and bundled knowledge/worker files.
 *
 * Usage: node scripts/verify-publish.mjs [--tag v0.8.6]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tagArg = process.argv.find((arg) => arg.startsWith('--tag='))?.slice('--tag='.length);
const envTag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
const tag = tagArg ?? envTag;
if (tag !== undefined && tag.length > 0) {
  const normalised = tag.startsWith('v') ? tag.slice(1) : tag;
  if (normalised !== pkg.version) {
    console.error(`tag ${tag} 与 package.json.version ${pkg.version} 不一致`);
    process.exit(1);
  }
}

const required = [
  'bin/dwguard.mjs',
  'lib/index.js',
  'lib/client.js',
  'lib/tools/audit.js',
  'knowledge/sops.json',
  'knowledge/engineering.json',
  'scripts/harness-worker.mjs',
  'scripts/soak.mjs',
  'preset/dwguard-hmos.cordis.yml',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md'
];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let raw;
try {
  raw = execSync(`${npm} pack --dry-run --json`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (error) {
  console.error(`npm pack --dry-run 失败：${error.stderr?.toString() ?? error.message}`);
  process.exit(1);
}
const start = raw.indexOf('[');
const end = raw.lastIndexOf(']');
let files = [];
try {
  const parsed = JSON.parse(raw.slice(start, end + 1));
  files = parsed[0]?.files?.map((entry) => entry.path) ?? [];
} catch {
  console.error('无法解析 npm pack 输出');
  process.exit(1);
}
const missing = required.filter((path) => !files.includes(path));
if (missing.length > 0) {
  console.error(`发布包缺少文件：${missing.join(', ')}`);
  process.exit(1);
}
if (files.some((path) => path.startsWith('tests/') || path.startsWith('node_modules/'))) {
  console.error('发布包不应包含 tests/ 或 node_modules/');
  process.exit(1);
}
console.log(`release gate ok: ${pkg.name}@${pkg.version} · ${files.length} files`);
