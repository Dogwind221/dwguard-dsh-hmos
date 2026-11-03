// Aesthetic learning v1 (0.6.1): AEST-A … AEST-K acceptance criteria.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Keep the workspace registry the tools write out of the real DSH home.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'dwguard-home-'));

import { adjustConfidence, extractAestheticFacts, learnAesthetics, readProfile } from '../lib/aesthetic.js';
import { compareMetrics, extractMetrics } from '../lib/baseline.js';
import { resolveOptions } from '../lib/config.js';
import { resolvePaths } from '../lib/paths.js';
import { createAestheticTool } from '../lib/tools/aesthetic.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createConfirmTool } from '../lib/tools/confirm.js';
import { createSpecTool } from '../lib/tools/spec.js';

const options = resolveOptions({});
const aestheticTool = createAestheticTool(options);
const specTool = createSpecTool(options);
const auditTool = createAuditTool(options);
const confirmTool = createConfirmTool(options);

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-aesthetic-'));
  dirs.push(dir);
  return dir;
}

function exec(cwd) {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };
}

function paths(cwd) {
  return resolvePaths(cwd, '.shared');
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

const baseCriteria = [
  {
    id: 'F-01',
    dimension: 'function',
    statement: '点击打卡后连续天数从 3 变成 4',
    verify: '操作步骤 + 截图 F-01.png'
  },
  {
    id: 'A-01',
    dimension: 'aesthetic',
    statement: '打卡卡片圆角 20vp、间距 12vp',
    verify: '布局树 bounds 实测 + 截图 A-01.png'
  },
  {
    id: 'P-01',
    dimension: 'performance',
    statement: '冷启动到首帧 ≤ 800ms',
    verify: 'Profiler 启动分析截图与毫秒数'
  },
  {
    id: 'X-01',
    dimension: 'accessibility',
    statement: '打卡按钮文字对比度 ≥ 4.5:1',
    verify: '截图取样计算对比度数值'
  }
];

const checks = [
  { criterionId: 'F-01', result: 'pass', evidence: '点击后截图显示连续天数 4' },
  { criterionId: 'A-01', result: 'pass', evidence: '布局树 bounds 实测圆角 20vp、间距 12vp' },
  { criterionId: 'P-01', result: 'pass', evidence: 'Profiler 冷启动 720ms' },
  { criterionId: 'X-01', result: 'pass', evidence: '对比度取样 4.9:1' }
];

async function writeSpec(cwd, aestheticExtra = {}) {
  const criteria = baseCriteria.map((criterion) =>
    criterion.dimension === 'aesthetic' ? { ...criterion, ...aestheticExtra } : criterion
  );
  return specTool.execute(
    {
      action: 'write',
      title: '训练打卡',
      requirement: '用户需要每天记录一次训练，并在首页看到连续打卡天数。',
      spec: '首页展示打卡卡片与连续天数；点击打卡写入本地存储并刷新天数。',
      constraints: ['compatibleSdkVersion 5.0.0(12)'],
      criteria
    },
    exec(cwd)
  );
}

async function writeProfileEntry(cwd, overrides = {}) {
  return aestheticTool.execute(
    {
      action: 'profile',
      op: 'write',
      area: 'radius',
      decision: '卡片圆角 20vp',
      number: 20,
      unit: 'vp',
      source: 'confirmation-1',
      confidence: 0.7,
      ...overrides
    },
    exec(cwd)
  );
}

async function writeBounds(cwd, relative, value) {
  const file = join(paths(cwd).shared, relative);
  await mkdir(join(paths(cwd).shared, 'artifacts', 'evidence'), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

const boundsV1 = {
  id: 'page',
  children: [
    {
      id: 'card',
      padding: { top: 8, right: 12, bottom: 8, left: 12 },
      radius: 16,
      fontSize: 14,
      backgroundColor: '#FFFFFF'
    }
  ]
};

const boundsV2 = {
  id: 'page',
  children: [
    {
      id: 'card',
      padding: { top: 9, right: 12, bottom: 8, left: 12 },
      radius: 19,
      fontSize: 15,
      backgroundColor: '#FFFEFE'
    }
  ]
};

test('AEST-A: profile write/read keeps every field', async () => {
  const cwd = await workspace();
  const result = await writeProfileEntry(cwd);
  assert.equal(result.ok, true, result.detail);
  const profile = await readProfile(paths(cwd));
  assert.equal(profile.entries.length, 1);
  const entry = profile.entries[0];
  assert.equal(entry.id, 'AES-RADIUS-01');
  assert.equal(entry.area, 'radius');
  assert.equal(entry.decision, '卡片圆角 20vp');
  assert.deepEqual(entry.value, { number: 20, unit: 'vp' });
  assert.equal(entry.source, 'confirmation-1');
  assert.equal(entry.confidence, 0.7);
  assert.equal(entry.status, 'active');
  assert.equal(entry.evidence.length, 0);
  assert.ok(entry.updatedAt.length > 0);

  const got = await aestheticTool.execute({ action: 'profile', op: 'get', id: 'AES-RADIUS-01' }, exec(cwd));
  assert.equal(got.ok, true);
  assert.match(got.summary, /AES-RADIUS-01/);
});

test('AEST-B: learn without apply returns proposals and leaves the profile bytes untouched', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  const profileFile = join(paths(cwd).shared, 'knowledge', 'aesthetic-profile.md');
  const before = await sha256(profileFile);
  const result = await aestheticTool.execute(
    {
      action: 'learn',
      sources: [
        { kind: 'confirmation', text: '间距保持 12vp' },
        { kind: 'confirmation', text: '卡片圆角改成 24vp' }
      ]
    },
    exec(cwd)
  );
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /提议/);
  assert.match(result.detail, /冲突/);
  assert.match(result.detail, /24vp/);
  assert.equal(await sha256(profileFile), before, 'learn 默认不得写档案');
});

test('AEST-C: confidence deltas (confirm +0.1 / reject −0.2 / repeat +0.05) clamp to 0–1', () => {
  assert.equal(adjustConfidence(0.7, 'confirm'), 0.8);
  assert.equal(adjustConfidence(0.7, 'reject'), 0.5);
  assert.equal(adjustConfidence(0.7, 'repeat'), 0.75);
  assert.equal(adjustConfidence(0.95, 'confirm'), 1);
  assert.equal(adjustConfidence(0.1, 'reject'), 0);
});

test('AEST-D: a different value for the same area is a conflict, never an overwrite', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  const profileFile = join(paths(cwd).shared, 'knowledge', 'aesthetic-profile.md');
  const before = await sha256(profileFile);
  const result = await aestheticTool.execute(
    { action: 'learn', sources: [{ kind: 'confirmation', text: '圆角改成 24vp' }] },
    exec(cwd)
  );
  assert.equal(result.ok, true);
  assert.match(result.detail, /需要用户裁决/);
  assert.match(result.detail, /24vp/);
  assert.equal(await sha256(profileFile), before);
  const profile = await readProfile(paths(cwd));
  assert.equal(profile.entries[0]?.value.number, 20, '旧值不能被悄悄覆盖');
});

test('AEST-E: apply needs a choice for conflicts, then supersedes the loser and keeps history', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  const profileFile = join(paths(cwd).shared, 'knowledge', 'aesthetic-profile.md');
  const before = await sha256(profileFile);

  const blocked = await aestheticTool.execute(
    {
      action: 'learn',
      sources: [{ kind: 'confirmation', text: '圆角改成 24vp' }],
      apply: true,
      confirmed: true
    },
    exec(cwd)
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail, /choice/i);
  assert.equal(await sha256(profileFile), before, '未裁决冲突不得写入');

  const applied = await aestheticTool.execute(
    {
      action: 'learn',
      sources: [{ kind: 'confirmation', text: '圆角改成 24vp' }],
      apply: true,
      confirmed: true,
      choice: '24vp'
    },
    exec(cwd)
  );
  assert.equal(applied.ok, true, applied.detail);
  const profile = await readProfile(paths(cwd));
  const old = profile.entries.find((entry) => entry.id === 'AES-RADIUS-01');
  const next = profile.entries.find((entry) => entry.status === 'active');
  assert.equal(old?.status, 'superseded');
  assert.equal(old?.supersededBy, next?.id);
  assert.equal(next?.value.number, 24);
  const history = await readFile(join(paths(cwd).shared, 'knowledge', 'aesthetic-history.jsonl'), 'utf8');
  assert.match(history, /superseded/);
  assert.match(history, /AES-RADIUS-01/);
});

test('AEST-F: baseline save is refused without a passing audit and a user confirmation', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  await writeBounds(cwd, 'artifacts/evidence/bounds-v1.json', boundsV1);
  const refused = await aestheticTool.execute(
    {
      action: 'baseline',
      op: 'save',
      page: 'home',
      state: 'default',
      bounds: 'artifacts/evidence/bounds-v1.json'
    },
    exec(cwd)
  );
  assert.equal(refused.ok, false);
  assert.match(refused.summary, /审计/);
});

test('AEST-G: compare enforces ±2vp for spacing/radius, 0 for font size and colours', () => {
  const baseline = extractMetrics(boundsV1);
  const worse = extractMetrics(boundsV2);
  const failed = compareMetrics(baseline, worse, {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(failed.pass, false);
  const byField = new Map(failed.rows.map((row) => [row.field, row]));
  assert.equal(byField.get('padding.top')?.verdict, 'pass', '±2vp 内的间距应通过');
  assert.equal(byField.get('radius')?.verdict, 'fail', '圆角 +3vp 超差');
  assert.equal(byField.get('fontSize')?.verdict, 'fail', '字号 0 容差');
  assert.equal(byField.get('backgroundColor')?.verdict, 'fail', '颜色必须完全一致');

  const same = compareMetrics(baseline, extractMetrics(boundsV1), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(same.pass, true);
});

test('AEST-H: the audit gate rejects a profileRef that is missing or superseded', async () => {
  const cwd = await workspace();
  await writeSpec(cwd, { profileRef: 'AES-RADIUS-99' });
  const blocked = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(blocked.ok, false);
  assert.match(blocked.detail, /不存在/);
  assert.match(blocked.detail, /AES-RADIUS-99/);

  const okCwd = await workspace();
  await writeProfileEntry(okCwd);
  await writeSpec(okCwd, { profileRef: 'AES-RADIUS-01' });
  const passed = await auditTool.execute({ checks }, exec(okCwd));
  assert.equal(passed.ok, true, passed.detail);
  const report = await readFile(join(paths(okCwd).shared, 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(report, /审美档案/);
  assert.match(report, /AES-RADIUS-01/);
});

test('AEST-I: cold start seeds palette/spacing/radius from project resources', async () => {
  const cwd = await workspace();
  const elementDir = join(cwd, 'resources', 'base', 'element');
  await mkdir(elementDir, { recursive: true });
  await writeFile(
    join(elementDir, 'color.json'),
    JSON.stringify({ color: [{ name: 'brand', value: '#FF6600' }] }),
    'utf8'
  );
  await writeFile(
    join(elementDir, 'float.json'),
    JSON.stringify({
      float: [
        { name: 'space_page', value: '16vp' },
        { name: 'corner_card', value: '20vp' },
        { name: 'font_body', value: '16vp' }
      ]
    }),
    'utf8'
  );
  const result = await aestheticTool.execute({ action: 'learn', coldStart: true }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /#FF6600/);
  assert.match(result.detail, /16vp/);
  assert.match(result.detail, /20vp/);
  assert.match(result.detail, /配色|间距|圆角/);
  const profileFile = join(paths(cwd).shared, 'knowledge', 'aesthetic-profile.md');
  await assert.rejects(readFile(profileFile), '冷启动提议同样不能落盘');
});

test('AEST-J: reports render the profileRef column and the baseline diff section', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  const spec = await writeSpec(cwd, { profileRef: 'AES-RADIUS-01' });
  assert.equal(spec.ok, true, spec.detail);

  const firstAudit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(firstAudit.ok, true, firstAudit.detail);
  const confirmed = await confirmTool.execute({ decision: 'accept', note: '用户确认' }, exec(cwd));
  assert.equal(confirmed.ok, true, confirmed.detail);

  await writeBounds(cwd, 'artifacts/evidence/bounds-v1.json', boundsV1);
  const saved = await aestheticTool.execute(
    {
      action: 'baseline',
      op: 'save',
      page: 'home',
      state: 'default',
      bounds: 'artifacts/evidence/bounds-v1.json'
    },
    exec(cwd)
  );
  assert.equal(saved.ok, true, saved.detail);

  await writeBounds(cwd, 'artifacts/evidence/bounds-v2.json', boundsV2);
  const compared = await aestheticTool.execute(
    { action: 'compare', page: 'home', state: 'default', bounds: 'artifacts/evidence/bounds-v2.json' },
    exec(cwd)
  );
  assert.equal(compared.ok, false);
  assert.match(compared.detail, /审美基线差异|未通过/);

  const secondAudit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(secondAudit.ok, true, secondAudit.detail);
  const report = await readFile(join(paths(cwd).shared, 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(report, /审美档案/);
  assert.match(report, /审美基线差异/);
  assert.match(report, /AES-RADIUS-01/);
  assert.match(report, /✗/);
  const auditJson = JSON.parse(await readFile(join(paths(cwd).shared, 'artifacts', 'audit-2.json'), 'utf8'));
  assert.equal(auditJson.aesthetic.profileRefs[0].profileRef, 'AES-RADIUS-01');
  assert.equal(auditJson.aesthetic.profileRefs[0].status, 'active');
  assert.equal(auditJson.aesthetic.compare.pass, false);
});

test('AEST-K: a profile write without a source is rejected', async () => {
  const cwd = await workspace();
  await assert.rejects(
    aestheticTool.execute(
      {
        action: 'profile',
        op: 'write',
        area: 'radius',
        decision: '卡片圆角 20vp',
        number: 20,
        confidence: 0.7
      },
      exec(cwd)
    ),
    /source|来源/
  );
  const profile = await readProfile(paths(cwd));
  assert.equal(profile.entries.length, 0);
});

test('spec rejects a malformed profileRef and hints at existing preferences', async () => {
  const cwd = await workspace();
  const malformed = await writeSpec(cwd, { profileRef: 'RADIUS-01' });
  assert.equal(malformed.ok, false);
  assert.match(malformed.detail, /AES-|格式/);

  const hintedCwd = await workspace();
  await writeProfileEntry(hintedCwd);
  const hinted = await writeSpec(hintedCwd);
  assert.equal(hinted.ok, true, hinted.detail);
  assert.match(hinted.detail, /没有引用审美档案/);
});

test('extraction is deterministic: clauses, keywords, numbers and colours', () => {
  const facts = extractAestheticFacts('卡片圆角 20vp，间距保持 12，主色 #FF6600，动效 240ms');
  const labels = facts.map((fact) => `${fact.area}:${fact.value.number ?? fact.value.color}${fact.value.unit ?? ''}`);
  assert.deepEqual(labels, ['radius:20vp', 'spacing:12vp', 'palette:#FF6600', 'motion:240ms']);
  const profile = { schemaVersion: 1, entries: [] };
  const first = learnAesthetics(profile, facts, new Map(), new Map());
  const second = learnAesthetics(profile, facts, new Map(), new Map());
  assert.deepEqual(first, second);
});
