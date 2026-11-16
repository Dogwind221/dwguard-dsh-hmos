#!/usr/bin/env node
/**
 * P1 benchmark: static ArkTS scan over a deterministic fixture.
 *
 * It measures end-to-end `scanWorkspace()` on 40 small files, after a warm-up.
 * Numbers are machine-dependent; use the same machine before/after a change.
 *
 *   node scripts/bench-scan.mjs --samples 10 --write-baseline
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { scanWorkspace } from '../lib/scan.js';

const args = { samples: 10, files: 40, writeBaseline: false, maxP95: null };
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key === '--samples') { args.samples = Number(process.argv[index + 1]); index += 1; }
  else if (key === '--files') { args.files = Number(process.argv[index + 1]); index += 1; }
  else if (key === '--write-baseline') args.writeBaseline = true;
  else if (key === '--max-p95-ms') { args.maxP95 = Number(process.argv[index + 1]); index += 1; }
}
if (!Number.isInteger(args.samples) || args.samples < 1 || !Number.isInteger(args.files) || args.files < 1) {
  console.error('samples/files must be positive integers');
  process.exit(2);
}

const BAD = `import { UIAbility } from '@ohos.app.ability.UIAbility'
import dayjs from '@ohos/dayjs'
@Entry @Component
struct Counter {
  @State items: number[] = []
  @State user: User = new User()
  label: any = 'x'
  build() {
    Column() {
      Button('add').onClick(() => { this.items.push(1) })
      Button('rename').onClick(() => { this.user.profile.name = 'x' })
      List() { ForEach(this.items, (item: number) => { ListItem() { Text(String(item)) } }) }
      Button('tick')
    }
  }
}
`;
const CLEAN = `@Entry @Component
struct Good {
  @State items: number[] = []
  build() {
    Column() {
      Button('add').accessibilityText('添加一条记录').onClick(() => { this.items = [...this.items, 1] })
      List() { LazyForEach(this.source, (item: string) => { ListItem() { Text(item) } }) }
    }
  }
}
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dwguard-bench-'));
  const pages = join(root, 'entry', 'src', 'main', 'ets', 'pages');
  await mkdir(pages, { recursive: true });
  for (let index = 0; index < args.files; index += 1) {
    await writeFile(join(pages, `Page${index}.ets`), index % 2 === 0 ? BAD : CLEAN, 'utf8');
  }
  return root;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const root = await fixture();
try {
  await scanWorkspace(root, true, new Date().toISOString());
  await scanWorkspace(root, true, new Date().toISOString());
  const samples = [];
  let hits = 0;
  for (let index = 0; index < args.samples; index += 1) {
    const started = performance.now();
    const report = await scanWorkspace(root, true, new Date().toISOString());
    samples.push(Number((performance.now() - started).toFixed(2)));
    hits = report.hits.length;
  }
  const result = {
    schemaVersion: 1,
    benchmark: 'scan-workspace',
    files: args.files,
    samples: args.samples,
    hits,
    unit: 'ms',
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
    values: samples
  };
  console.log(JSON.stringify(result, null, 2));
  if (args.writeBaseline) {
    mkdirSync('benchmarks', { recursive: true });
    writeFileSync('benchmarks/scan-baseline.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log('wrote benchmarks/scan-baseline.json');
  }
  if (args.maxP95 !== null && result.p95 > args.maxP95) {
    console.error(`p95 ${result.p95}ms > budget ${args.maxP95}ms`);
    process.exitCode = 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
