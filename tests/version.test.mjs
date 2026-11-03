// Release hygiene: published install instructions and the changelog must track
// `package.json`. 0.4.2 was a hand-fix for exactly this drift; this gate keeps it
// from recurring.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const escaped = version.replace(/\./g, '\\.');

function pins(text) {
  return [...text.matchAll(/dwguard-dsh-hmos@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
}

test('README.md install pins track package.json', async () => {
  const zh = await readFile(join(root, 'README.md'), 'utf8');
  assert.match(zh, new RegExp(`（当前 ${escaped}）`));
  const found = pins(zh);
  assert.ok(found.length >= 2, 'README.md 至少要有桌面版与 CLI 两处固定版本示例');
  for (const pin of found) assert.equal(pin, version, `README.md 仍写着 ${pin}`);
  const tags = [...zh.matchAll(/git tag v(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  assert.ok(tags.length >= 1, 'README.md 应包含发版 tag 示例');
  for (const tag of tags) assert.equal(tag, version, `README.md 的 tag 示例仍是 v${tag}`);
});

test('README.en.md install pins track package.json', async () => {
  const en = await readFile(join(root, 'README.en.md'), 'utf8');
  assert.match(en, new RegExp(`\\(current ${escaped}\\)`));
  const found = pins(en);
  assert.ok(found.length >= 2, 'README.en.md 至少要有两处固定版本示例');
  for (const pin of found) assert.equal(pin, version, `README.en.md 仍写着 ${pin}`);
});

test('CHANGELOG.md starts with a section for the current version', async () => {
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  const firstHeading = changelog.split('\n').find((line) => line.startsWith('## '));
  assert.ok(firstHeading !== undefined, 'CHANGELOG.md 没有任何 `## ` 小节');
  assert.match(firstHeading, new RegExp(`^## ${escaped} — \\d{4}-\\d{2}-\\d{2}$`));
});

test('the published package name is spelled dwguard-dsh-hmos everywhere', async () => {
  assert.equal(pkg.name, 'dwguard-dsh-hmos');
  const files = ['README.md', 'README.en.md', 'CHANGELOG.md'];
  for (const dir of ['docs', 'skills']) {
    const entries = await readdir(join(root, dir));
    for (const entry of entries) {
      if (entry.endsWith('.md')) files.push(`${dir}/${entry}`);
    }
  }
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    assert.doesNotMatch(text, /dwgward/, `${file} 把包名写成了 dwgward-dsh-hmos（安装会失败）`);
  }
});

