// 0.9.6 non-breaking evidence contract: requiredEvidence, evidenceRefs, coverage.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyRequiredEvidenceVerdicts, gateDelivery, normalizeChecks, summarizeCoverage } from '../lib/review.js';
import { buildTaskPack } from '../lib/spec.js';

const basePack = {
  schemaVersion: 1,
  title: 'evidence contract',
  requirement: 'A design change must carry typed evidence without changing legacy packs.',
  spec: 'Keep old evidenceFiles behavior and add optional typed evidence.',
  constraints: [],
  criteria: [
    { id: 'F-01', dimension: 'function', statement: '点击后计数从 3 变成 4', verify: '截图 + 布局树', weight: 'must' },
    {
      id: 'A-01',
      dimension: 'aesthetic',
      statement: '视觉改动的 before/after 都存在',
      verify: '前后截图 + 布局树',
      weight: 'must',
      requiredEvidence: ['screenshot_before', 'screenshot_after']
    },
    { id: 'P-01', dimension: 'performance', statement: '冷启动 ≤800ms', verify: 'Profiler 采样', weight: 'must' },
    { id: 'X-01', dimension: 'accessibility', statement: '按钮触控热区 ≥48vp', verify: '布局树 bounds', weight: 'must' }
  ],
  iteration: 1,
  specVersion: 1,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z'
};

const passCheck = (criterionId, extra = {}) => ({
  criterionId,
  result: 'pass',
  evidence: '独立取证：设备截图/布局树已核对，结果为预期值。',
  evidenceFiles: ['artifacts/shot.png'],
  ...extra
});

test('buildTaskPack preserves requiredEvidence and dedupes it', () => {
  const pack = buildTaskPack(
    {
      title: 'p',
      requirement: 'r',
      spec: 's',
      criteria: [
        {
          id: 'A-01',
          dimension: 'aesthetic',
          statement: '视觉改动有前后截图',
          verify: '截图',
          requiredEvidence: ['screenshot_before', 'screenshot_after', 'screenshot_after']
        },
        { id: 'F-01', dimension: 'function', statement: '功能可用', verify: '截图' }
      ]
    },
    { iteration: 1, specVersion: 1, createdAt: 'x', updatedAt: 'x' }
  );
  assert.deepEqual(pack.criteria[0].requiredEvidence, ['screenshot_before', 'screenshot_after']);
  assert.equal(pack.criteria[1].requiredEvidence, undefined);
});

test('a pass missing requiredEvidence becomes unverified and blocks a must criterion', () => {
  const checks = [
    passCheck('F-01'),
    passCheck('A-01', {
      evidenceFiles: ['artifacts/after.png'],
      evidenceRefs: [{ path: 'artifacts/after.png', kind: 'screenshot_after' }]
    }),
    passCheck('P-01'),
    passCheck('X-01')
  ];
  const adjusted = applyRequiredEvidenceVerdicts(basePack, normalizeChecks(checks));
  assert.equal(adjusted.find((check) => check.criterionId === 'A-01').result, 'unverified');
  const coverage = summarizeCoverage(basePack, adjusted);
  assert.equal(coverage.evidence.required, 2);
  assert.equal(coverage.evidence.satisfied, 1);
  assert.deepEqual(coverage.evidence.missing, [{ criterionId: 'A-01', kind: 'screenshot_before' }]);
  const gate = gateDelivery(basePack, adjusted, []);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /未验证|缺少必需的/);
});

test('before/after only applies when the criterion declares it', () => {
  const checks = [
    passCheck('F-01'),
    passCheck('A-01', {
      evidenceFiles: ['artifacts/before.png', 'artifacts/after.png'],
      evidenceRefs: [
        { path: 'artifacts/before.png', kind: 'screenshot_before' },
        { path: 'artifacts/after.png', kind: 'screenshot_after' }
      ]
    }),
    passCheck('P-01'),
    passCheck('X-01')
  ];
  const adjusted = applyRequiredEvidenceVerdicts(basePack, normalizeChecks(checks));
  assert.ok(adjusted.every((check) => check.result === 'pass'));
  assert.equal(summarizeCoverage(basePack, adjusted).evidence.satisfied, 2);

  const legacyPack = { ...basePack, criteria: basePack.criteria.map(({ requiredEvidence, ...criterion }) => criterion) };
  const legacy = applyRequiredEvidenceVerdicts(legacyPack, normalizeChecks([passCheck('A-01')]));
  assert.equal(legacy[0].result, 'pass');
  assert.equal(summarizeCoverage(legacyPack, legacy).evidence, undefined);
});

test('a typed ref must point at a file also listed in evidenceFiles', () => {
  const check = passCheck('A-01', {
    evidenceFiles: ['artifacts/after.png'],
    evidenceRefs: [{ path: 'artifacts/not-copied.png', kind: 'screenshot_after' }]
  });
  const gate = gateDelivery(basePack, normalizeChecks([check]), []);
  assert.equal(gate.pass, false);
  assert.match(gate.errors.join('\n'), /evidenceRefs 路径/);
});
