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
import { baselineFileStem, compareMetrics, extractMetrics, readBaselineIndex } from '../lib/baseline.js';
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

  // Two contradictory values in the same round are a conflict too, not two proposals.
  const fresh = await workspace();
  const ambiguous = await aestheticTool.execute(
    { action: 'learn', sources: [{ kind: 'confirmation', text: '圆角 20vp 或 24vp' }] },
    exec(fresh)
  );
  assert.equal(ambiguous.ok, true, ambiguous.detail);
  assert.match(ambiguous.detail, /冲突/);
  assert.match(ambiguous.detail, /20vp/);
  assert.match(ambiguous.detail, /24vp/);
  await assert.rejects(readFile(join(paths(fresh).shared, 'knowledge', 'aesthetic-profile.md'), 'utf8'));
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
  assert.equal(auditJson.aesthetic.compares[0].pass, false);
  assert.match(report, /审美基线未通过/);
  assert.equal((report.match(/审美基线差异/g) ?? []).length, 1, '基线小节标题不应重复');

  // Two pages must both survive; the audit attaches every compare, not just the last one.
  await writeBounds(cwd, 'artifacts/evidence/detail-v1.json', boundsV1);
  const secondBaseline = await aestheticTool.execute(
    { action: 'baseline', op: 'save', page: 'detail', state: 'default', bounds: 'artifacts/evidence/detail-v1.json' },
    exec(cwd)
  );
  assert.equal(secondBaseline.ok, true, secondBaseline.detail);
  await writeBounds(cwd, 'artifacts/evidence/detail-v2.json', boundsV2);
  const secondCompare = await aestheticTool.execute(
    { action: 'compare', page: 'detail', state: 'default', bounds: 'artifacts/evidence/detail-v2.json' },
    exec(cwd)
  );
  assert.equal(secondCompare.ok, false);
  const thirdAudit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(thirdAudit.ok, true, thirdAudit.detail);
  const thirdJson = JSON.parse(await readFile(join(paths(cwd).shared, 'artifacts', 'audit-3.json'), 'utf8'));
  assert.equal(thirdJson.aesthetic.compares.length, 2);
  const thirdReport = await readFile(join(paths(cwd).shared, 'artifacts', 'acceptance-report.md'), 'utf8');
  assert.match(thirdReport, /home/);
  assert.match(thirdReport, /detail/);
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

  const ambiguous = learnAesthetics(profile, extractAestheticFacts('圆角 20vp 或 24vp'), new Map(), new Map());
  assert.equal(ambiguous.proposals.length, 0);
  assert.equal(ambiguous.conflicts.length, 1);
  assert.equal(ambiguous.conflicts[0]?.candidates.length, 2);

  // M1: `、` and ASCII commas are clause separators; each number maps to its
  // own keyword, not to whichever keyword appears furthest right.
  const listSeparated = extractAestheticFacts('卡片圆角 20、间距 12');
  assert.deepEqual(
    listSeparated.map((fact) => `${fact.area}:${fact.value.number}${fact.value.unit}`),
    ['radius:20vp', 'spacing:12vp']
  );
  const commaSeparated = extractAestheticFacts('圆角 20, 间距 12');
  assert.deepEqual(
    commaSeparated.map((fact) => `${fact.area}:${fact.value.number}${fact.value.unit}`),
    ['radius:20vp', 'spacing:12vp']
  );
  const numberFirst = extractAestheticFacts('20vp 圆角');
  assert.deepEqual(numberFirst.map((fact) => fact.area), ['radius']);
});

test('M2: multiple conflicts need per-area choices; an ambiguous single choice is refused', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  await writeProfileEntry(cwd, {
    area: 'spacing',
    decision: '间距 12vp',
    number: 12,
    source: 'confirmation-2'
  });
  const apply = (extra) =>
    aestheticTool.execute(
      {
        action: 'learn',
        sources: [{ kind: 'confirmation', text: '圆角改成 24vp，间距改成 16vp' }],
        apply: true,
        confirmed: true,
        ...extra
      },
      exec(cwd)
    );

  const partial = await apply({ choice: '24vp' });
  assert.equal(partial.ok, false, '一个 choice 不能同时裁决两个领域');
  assert.match(partial.detail, /间距|冲突/);

  const ambiguous = await apply({
    choice: '16vp',
    sources: [{ kind: 'confirmation', text: '圆角改成 16vp，间距改成 16vp' }]
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.summary + ambiguous.detail, /同时匹配|歧义|冲突/);

  const resolved = await apply({ choices: { radius: '24vp', spacing: '16vp' } });
  assert.equal(resolved.ok, true, resolved.detail);
  const profile = await readProfile(paths(cwd));
  const active = profile.entries.filter((entry) => entry.status === 'active');
  assert.deepEqual(active.map((entry) => `${entry.area}:${entry.value.number}`).sort(), ['radius:24', 'spacing:16']);
  assert.ok(profile.entries.some((entry) => entry.status === 'superseded' && entry.area === 'radius'));
  assert.ok(profile.entries.some((entry) => entry.status === 'superseded' && entry.area === 'spacing'));
});

test('M3: rejection evidence of the held value lowers confidence instead of raising it', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd, {
    area: 'spacing',
    decision: '间距 12vp',
    number: 12,
    source: 'confirmation-1',
    confidence: 0.7
  });
  const applied = await aestheticTool.execute(
    {
      action: 'learn',
      sources: [{ kind: 'rejection', text: '间距 12 太挤了' }],
      apply: true,
      confirmed: true
    },
    exec(cwd)
  );
  assert.equal(applied.ok, true, applied.detail);
  const profile = await readProfile(paths(cwd));
  const entry = profile.entries.find((item) => item.area === 'spacing');
  assert.equal(entry?.confidence, 0.5, '0.7 - 0.2');
  assert.equal(profile.entries.filter((item) => item.status === 'active').length, 1, '不应新增条目');
});

test('M4: baseline save passes only after a passing audit and a user confirmation', async () => {
  const cwd = await workspace();
  await writeSpec(cwd);
  await writeBounds(cwd, 'artifacts/evidence/bounds-v1.json', boundsV1);
  const audit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(audit.ok, true, audit.detail);
  const beforeConfirm = await aestheticTool.execute(
    { action: 'baseline', op: 'save', page: 'home', state: 'default', bounds: 'artifacts/evidence/bounds-v1.json' },
    exec(cwd)
  );
  assert.equal(beforeConfirm.ok, false);
  assert.match(beforeConfirm.summary + beforeConfirm.detail, /确认/);

  const confirmed = await confirmTool.execute({ decision: 'accept' }, exec(cwd));
  assert.equal(confirmed.ok, true, confirmed.detail);
  const afterConfirm = await aestheticTool.execute(
    { action: 'baseline', op: 'save', page: 'home', state: 'default', bounds: 'artifacts/evidence/bounds-v1.json' },
    exec(cwd)
  );
  assert.equal(afterConfirm.ok, true, afterConfirm.detail);
});

test('M5/G: units are part of the comparison and an empty baseline cannot pass', () => {
  const fpBaseline = extractMetrics({ id: 'card', fontSize: '14fp', radius: '16vp' });
  const sameFp = compareMetrics(fpBaseline, extractMetrics({ id: 'card', fontSize: '14fp', radius: '16vp' }), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(sameFp.pass, true);
  const wrongUnit = compareMetrics(fpBaseline, extractMetrics({ id: 'card', fontSize: '14vp', radius: '16vp' }), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(wrongUnit.pass, false);
  assert.match(wrongUnit.rows.find((row) => row.field === 'fontSize')?.reason ?? '', /单位不一致/);

  const boundary = compareMetrics(extractMetrics({ id: 'card', radius: '16vp' }), extractMetrics({ id: 'card', radius: '18vp' }), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(boundary.pass, true, '±2vp 边界应通过');
  const beyond = compareMetrics(extractMetrics({ id: 'card', radius: '16vp' }), extractMetrics({ id: 'card', radius: '18.5vp' }), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(beyond.pass, false);

  const missingNode = compareMetrics(extractMetrics({ id: 'card', radius: '16vp' }), extractMetrics({ id: 'other', radius: '16vp' }), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(missingNode.pass, false);
  const missingField = compareMetrics(extractMetrics({ id: 'card', radius: '16vp' }), extractMetrics({ id: 'card' }), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(missingField.pass, false);

  const empty = compareMetrics(extractMetrics({ id: 'page' }), extractMetrics({ id: 'page' }), {
    at: '2026-11-03T00:00:00.000Z',
    specVersion: 1,
    page: 'home',
    state: 'default'
  });
  assert.equal(empty.pass, false, '没有可测量字段不能判为一致');
});

test('M6: an unparseable profile is never overwritten, and backticks round-trip', async () => {
  const cwd = await workspace();
  const written = await writeProfileEntry(cwd, { decision: '圆角 like ```inline``` 20vp' });
  assert.equal(written.ok, true, written.detail);
  const roundTrip = await readProfile(paths(cwd));
  assert.equal(roundTrip.entries.length, 1);
  assert.match(roundTrip.entries[0]?.decision ?? '', /```inline```/);

  const profileFile = join(paths(cwd).shared, 'knowledge', 'aesthetic-profile.md');
  const before = await readFile(profileFile, 'utf8');
  await writeFile(profileFile, `${before.split('<!-- aesthetic-profile:json -->')[0]}<!-- aesthetic-profile:json -->\n\n{ broken`, 'utf8');
  const corrupted = await aestheticTool.execute(
    {
      action: 'profile',
      op: 'write',
      area: 'spacing',
      decision: '间距 12vp',
      number: 12,
      source: 'confirmation-2',
      confidence: 0.7
    },
    exec(cwd)
  );
  assert.equal(corrupted.ok, false);
  assert.match(corrupted.summary + corrupted.detail, /无法解析|JSON/);
  assert.match(await readFile(profileFile, 'utf8'), /\{ broken/, '坏档案必须保持原样');
});

test('M2b: profile write that replaces an active value needs confirmed: true', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  const blocked = await aestheticTool.execute(
    {
      action: 'profile',
      op: 'write',
      area: 'radius',
      decision: '圆角改成 24vp',
      number: 24,
      source: 'design-review',
      confidence: 0.8
    },
    exec(cwd)
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary + blocked.detail, /confirmed|取代/);

  const confirmed = await aestheticTool.execute(
    {
      action: 'profile',
      op: 'write',
      area: 'radius',
      decision: '圆角改成 24vp',
      number: 24,
      source: 'design-review',
      confidence: 0.8,
      confirmed: true
    },
    exec(cwd)
  );
  assert.equal(confirmed.ok, true, confirmed.detail);
  const profile = await readProfile(paths(cwd));
  assert.equal(profile.entries.find((entry) => entry.status === 'active')?.value.number, 24);
  assert.ok(profile.entries.some((entry) => entry.status === 'superseded' && entry.value.number === 20));
});

test('m3: cold start also finds <module>/src/main/resources/base/element', async () => {
  const cwd = await workspace();
  const elementDir = join(cwd, 'entry', 'src', 'main', 'resources', 'base', 'element');
  await mkdir(elementDir, { recursive: true });
  await writeFile(
    join(elementDir, 'color.json'),
    JSON.stringify({ color: [{ name: 'brand', value: '#123456' }] }),
    'utf8'
  );
  await writeFile(
    join(elementDir, 'float.json'),
    JSON.stringify({ float: [{ name: 'corner_card', value: '18vp' }] }),
    'utf8'
  );
  const result = await aestheticTool.execute({ action: 'learn', coldStart: true }, exec(cwd));
  assert.equal(result.ok, true, result.detail);
  assert.match(result.detail, /#123456/);
  assert.match(result.detail, /18vp/);
});

test('AEST-Hb: a superseded profileRef is rejected by the audit gate', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  const removed = await aestheticTool.execute({ action: 'profile', op: 'remove', id: 'AES-RADIUS-01' }, exec(cwd));
  assert.equal(removed.ok, true, removed.detail);
  await writeSpec(cwd, { profileRef: 'AES-RADIUS-01' });
  const audit = await auditTool.execute({ checks }, exec(cwd));
  assert.equal(audit.ok, false);
  assert.match(audit.detail, /superseded/);
});

test('AEST-Eb: choosing the existing value raises confidence without a new entry', async () => {
  const cwd = await workspace();
  await writeProfileEntry(cwd);
  const applied = await aestheticTool.execute(
    {
      action: 'learn',
      sources: [{ kind: 'confirmation', text: '圆角改成 24vp' }],
      apply: true,
      confirmed: true,
      choice: '20vp'
    },
    exec(cwd)
  );
  assert.equal(applied.ok, true, applied.detail);
  const profile = await readProfile(paths(cwd));
  const entry = profile.entries.find((item) => item.id === 'AES-RADIUS-01');
  assert.equal(entry?.status, 'active');
  assert.equal(entry?.confidence, 0.8, '确认 +0.1');
  assert.equal(profile.entries.length, 1, '选择保留时不应新增条目');
});

test('AEST-Bb: apply without confirmed: true is refused and writes nothing', async () => {
  const cwd = await workspace();
  const result = await aestheticTool.execute(
    { action: 'learn', sources: [{ kind: 'confirmation', text: '间距保持 12vp' }], apply: true },
    exec(cwd)
  );
  assert.equal(result.ok, false);
  assert.match(result.summary, /确认/);
  await assert.rejects(readFile(join(paths(cwd).shared, 'knowledge', 'aesthetic-profile.md'), 'utf8'));
});

test('n4/n6: baseline keys stay unique and the index refuses path-like file names', async () => {
  const cwd = await workspace();
  const p = paths(cwd);
  const dir = join(p.visualBaselineDir, '1');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      specVersion: 1,
      entries: [
        { page: 'home', state: 'a', boundsFile: '..', boundsSha256: 'x', savedAt: '', auditId: 1, confirmationId: 1 },
        { page: 'home', state: 'b', boundsFile: '.', boundsSha256: 'x', savedAt: '', auditId: 1, confirmationId: 1 }
      ]
    }),
    'utf8'
  );
  const index = await readBaselineIndex(p, 1);
  assert.equal(index.entries.length, 0, '`..` / `.` 不能进入索引');
  assert.notEqual(baselineFileStem('a.b', 'default'), baselineFileStem('a_b', 'default'));
  assert.equal(baselineFileStem('a.b', 'default'), baselineFileStem('a.b', 'default'));
});
