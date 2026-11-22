// Package / permission / privacy audit (1.0.5): declared vs referenced checks,
// structural signature presence and size budget.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-pkg-home-'));
import { resolveOptions } from '../lib/config.js';
import { createDevecoTool } from '../lib/tools/deveco.js';

const dirs = [process.env.DSH_HOME];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function write(file, content) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

function exec(cwd) {
  const controller = new AbortController();
  return { signal: controller.signal, agent: { session: { header: { cwd } } } };
}

test('project op=audit reports undeclared permissions and privacy gaps', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dwguard-pkg-ws-'));
  dirs.push(cwd);
  await write(join(cwd, 'build-profile.json5'), `{ "modules": [{ "name": "entry", "srcPath": "./entry" }] }`);
  await write(join(cwd, 'AppScope', 'app.json5'), `{ "app": { "bundleName": "com.demo.audit" } }`);
  await write(
    join(cwd, 'entry', 'src', 'main', 'module.json5'),
    JSON.stringify(
      {
        module: {
          name: 'entry',
          type: 'entry',
          deviceTypes: ['phone'],
          requestPermissions: [
            { name: 'ohos.permission.CAMERA', reason: '$string:camera_reason', usedScene: { when: 'inuse' } },
            { name: 'ohos.permission.LOCATION' }
          ],
          abilities: [{ name: 'EntryAbility' }]
        }
      },
      null,
      2
    )
  );
  await write(
    join(cwd, 'entry', 'src', 'main', 'ets', 'pages', 'Index.ets'),
    `const camera = 'ohos.permission.CAMERA';\nconst network = 'ohos.permission.INTERNET';\n`
  );
  await write(
    join(cwd, 'entry', 'build', 'default', 'outputs', 'default', 'entry-default-signed.hap'),
    'PK\u0003\u0004 META-INF/TEST.RSA META-INF/TEST.SF payload'
  );

  const tool = createDevecoTool(resolveOptions({}));
  const result = await tool.execute({ action: 'project', op: 'audit' }, exec(cwd));
  assert.equal(result.ok, false, result.detail ?? result.summary);
  assert.match(result.summary, /blocker/);
  const stored = JSON.parse(await readFile(join(cwd, '.shared', 'artifacts', 'deveco-1', 'project-audit.json'), 'utf8'));
  assert.ok(stored.missingDeclaration.includes('ohos.permission.INTERNET'));
  assert.ok(stored.privacyMissing.some((entry) => entry.name === 'ohos.permission.LOCATION'));
  assert.equal(stored.artifacts.length, 1);
  assert.equal(stored.artifacts[0].structurallySigned, true);

  const withBudget = await tool.execute({ action: 'project', op: 'audit', maxHapMb: 0.000001 }, exec(cwd));
  assert.equal(withBudget.ok, false);
  assert.match(withBudget.detail, /超过预算/);
});
