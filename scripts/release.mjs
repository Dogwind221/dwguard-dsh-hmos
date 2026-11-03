#!/usr/bin/env node
/**
 * Release helper: bump the version, rebuild `lib/`, and produce an npm tarball.
 *
 * Usage:
 *   node scripts/release.mjs --bump=patch|minor|major [--dry-run]
 *   node scripts/release.mjs --version=0.3.0 [--dry-run]
 *
 * It never publishes. After a successful pack it prints the tag/publish steps.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Compute the next semantic version.
 * @param current - e.g. `0.2.0`.
 * @param bump - `patch` | `minor` | `major`.
 */
export function bumpVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (match === null) throw new Error(`invalid version: ${current}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else if (bump === 'patch') {
    patch += 1;
  } else {
    throw new Error(`invalid bump: ${bump} (expected patch / minor / major)`);
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Rewrite the version references that live in the READMEs so a bump can never
 * leave the install instructions pinning an older release.
 *
 * The patterns are deliberately narrow: only the "current version" note, the
 * `dwguard-dsh-hmos@x.y.z` pin examples and the `git tag vx.y.z` release
 * command are rewritten. Historical CHANGELOG entries stay untouched.
 *
 * @param text - current README text.
 * @param version - version to write, e.g. `0.6.1`.
 * @param lang - `zh` for README.md, `en` for README.en.md.
 */
export function syncVersionText(text, version, lang) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid version: ${version}`);
  const patterns = [
    [/dwguard-dsh-hmos@\d+\.\d+\.\d+/g, `dwguard-dsh-hmos@${version}`],
    [/git tag v\d+\.\d+\.\d+/g, `git tag v${version}`],
    [/git push origin v\d+\.\d+\.\d+/g, `git push origin v${version}`]
  ];
  if (lang === 'zh') {
    patterns.unshift([/（当前 \d+\.\d+\.\d+）/g, `（当前 ${version}）`]);
  } else {
    patterns.unshift([/\(current \d+\.\d+\.\d+\)/g, `(current ${version})`]);
  }
  let next = text;
  for (const [pattern, replacement] of patterns) next = next.replace(pattern, replacement);
  return next;
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match === null) continue;
    options[match[1]] = match[2] ?? 'true';
  }
  return options;
}

function run(command, args, shell = process.platform === 'win32') {
  // `process.execPath` is an absolute Windows path ("C:\Program Files\…");
  // routing it through a shell splits it at the space. Node runs fine without one.
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result.status ?? '?'}`);
  }
}

/**
 * Run an npm subcommand. When invoked via `npm run release`, `npm_execpath`
 * points at npm's own JS entry, so the script works even when `npm` is not on
 * PATH (common on Windows with a custom node install).
 */
function runNpm(args) {
  const execPath = process.env['npm_execpath'];
  if (typeof execPath === 'string' && execPath.length > 0) {
    run(process.execPath, [execPath, ...args], false);
    return;
  }
  run('npm', args);
}

async function main(argv) {
  const options = parseArgs(argv);
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const current = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  const next =
    typeof options.version === 'string' && options.version !== 'true'
      ? options.version
      : bumpVersion(current, options.bump === undefined || options.bump === 'true' ? 'patch' : options.bump);
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error(`invalid target version: ${next}`);

  // The changelog entry is written by hand before the release; refuse to bump
  // when the heading is missing so a release can never ship notes-less.
  const changelogPath = join(ROOT, 'CHANGELOG.md');
  const changelog = await readFile(changelogPath, 'utf8');
  if (!new RegExp(`^## ${next.replace(/\./g, '\\.')} — `, 'm').test(changelog)) {
    throw new Error(
      `CHANGELOG.md 缺少 \`## ${next} — <date>\` 小节；先写变更记录，再跑 release。`
    );
  }

  console.log(`version: ${current} -> ${next}${options['dry-run'] === 'true' ? ' (dry run)' : ''}`);
  if (options['dry-run'] === 'true') {
    console.log('would update: package.json, README.md, README.en.md');
    return;
  }

  pkg.version = next;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  // Keep the install pins in sync with the version we just wrote. 0.4.2 was a
  // hand-fix for exactly this drift; the bump must handle it from now on.
  for (const [file, lang] of [['README.md', 'zh'], ['README.en.md', 'en']]) {
    const filePath = join(ROOT, file);
    const before = await readFile(filePath, 'utf8');
    const after = syncVersionText(before, next, lang);
    if (after !== before) {
      await writeFile(filePath, after, 'utf8');
      console.log(`updated version references: ${file}`);
    }
  }

  console.log('rebuilding lib/ ...');
  runNpm(['run', 'build']);
  console.log('packing ...');
  runNpm(['pack']);
  console.log(`\ndone: ${pkg.name}@${next}`);
  console.log('next steps:');
  console.log(`  git tag v${next} && git push origin v${next}`);
  console.log('  npm publish --access public');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
