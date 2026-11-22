// Static scan: the classic ArkTS pitfalls must be caught with rule IDs, and a
// clean file must stay clean.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { scanWorkspace } from '../lib/scan.js';

const dirs = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), 'dwguard-scan-'));
  dirs.push(dir);
  return dir;
}

const bad = `import { UIAbility } from '@ohos.app.ability.UIAbility'
import dayjs from '@ohos/dayjs'

@Entry
@Component
struct Counter {
  @State items: number[] = []
  @State user: User = new User()
  label: any = 'x'

  build() {
    Column() {
      Button('add').onClick(() => {
        this.items.push(1)
      })
      Button('rename').onClick(() => {
        this.user.profile.name = 'x'
      })
      List() {
        ForEach(this.items, (item: number) => {
          ListItem() { Text(String(item)) }
        })
      }
      Button('tick')
    }
  }
}
`;

const mixed = `@Component
struct A {
  @State count: number = 0
  @Local name: string = ''
  build() { Text(this.name) }
}
`;

const clean = `@Entry
@Component
struct Good {
  @State items: number[] = []

  build() {
    Column() {
      Button('add')
        .accessibilityText('添加一条记录')
        .onClick(() => {
          this.items = [...this.items, 1]
        })
      List() {
        LazyForEach(this.source, (item: string) => {
          ListItem() { Text(item) }
        })
      }
    }
  }
}
`;

test('scan catches ArkTS pitfalls with stable rule IDs', async () => {
  const root = await workspace();
  await mkdir(join(root, 'entry', 'src', 'main', 'ets'), { recursive: true });
  await writeFile(join(root, 'entry', 'src', 'main', 'ets', 'Bad.ets'), bad);
  await writeFile(join(root, 'entry', 'src', 'main', 'ets', 'Mixed.ets'), mixed);

  const report = await scanWorkspace(root);
  const ids = new Set(report.hits.map((hit) => hit.ruleId));

  for (const ruleId of [
    'STATE-NESTED-01',
    'ARKTS-ANY-001',
    'ARKTS-IMPORT-KIT',
    'ARKTS-V1V2-MIX',
    'OHPM-FAKE-001',
    'PERF-LIST-FOREACH',
    'A11Y-TEXT-001'
  ]) {
    assert.ok(ids.has(ruleId), `missing ${ruleId}; got ${[...ids].join(', ')}`);
  }
  assert.ok(report.counts.must >= 5, `expected at least 5 must hits, got ${report.counts.must}`);

  const stateHit = report.hits.find((hit) => hit.ruleId === 'STATE-NESTED-01');
  assert.ok(stateHit, 'STATE-NESTED-01 must point at the nested assignment');
  assert.match(stateHit.file, /Bad\.ets$/);
  assert.equal(stateHit.line, bad.split('\n').indexOf("        this.user.profile.name = 'x'") + 1);
  assert.match(stateHit.excerpt, /this\.user\.profile\.name/);

  // @State 数组的 push/pop 在现行 ArkUI 中是可观察的，不得误报。
  assert.ok(
    !report.hits.some((hit) => hit.excerpt.includes('this.items.push(1)')),
    'array push must not be reported as a state bug'
  );

  const mixHit = report.hits.find((hit) => hit.ruleId === 'ARKTS-V1V2-MIX');
  assert.ok(mixHit);
  assert.match(mixHit.file, /Mixed\.ets$/);
});

test('scan leaves clean code alone and can hide warnings', async () => {
  const root = await workspace();
  await mkdir(join(root, 'entry', 'src', 'main', 'ets'), { recursive: true });
  await writeFile(join(root, 'entry', 'src', 'main', 'ets', 'Good.ets'), clean);

  const report = await scanWorkspace(root);
  assert.equal(report.counts.must, 0);
  assert.equal(report.hits.length, 0);

  const mustOnly = await scanWorkspace(root, false);
  assert.equal(mustOnly.counts.warn, 0);

  // Incremental mode: a cutoff in the future skips every file.
  const incremental = await scanWorkspace(root, true, new Date().toISOString(), {
    sinceMs: Date.now() + 60_000
  });
  assert.equal(incremental.files, 0);
  assert.equal(incremental.hits.length, 0);
});

// Shapes lifted from WindwindLure (a real third-party HarmonyOS app, 2026-11-22).
// The scanner used to report all three of them as defects: a `===` comparison,
// a `@Builder bottomButton()`, and a 4-item tab-bar `ForEach` in a `Row` that
// shared a file with an unrelated `List(`.
const realWorld = `@Component
struct Page {
  @State post: Post = new Post()

  private currentColor(): string {
    if (this.post === null || this.post.imageColors.length === 0) {
      return '#fff'
    }
    if (this.post.catchId !== '' && this.post.images.length >= 1) {
      return '#000'
    }
    return '#111'
  }

  @Builder
  bottomButton() {
    Text('done')
  }

  build() {
    Column() {
      Row({ space: 8 }) {
        ForEach(this.categoryLabels, (label: string) => {
          Text(label)
        })
      }
      List({ space: 10 }) {
        Text('static row')
      }
    }
  }
}
`;

test('scan ignores real-world false positives (comparisons, builder names, header loops)', async () => {
  const root = await workspace();
  await mkdir(join(root, 'entry', 'src', 'main', 'ets'), { recursive: true });
  await writeFile(join(root, 'entry', 'src', 'main', 'ets', 'Page.ets'), realWorld);

  const report = await scanWorkspace(root);
  assert.deepEqual(
    report.hits.map((hit) => `${hit.ruleId}@${hit.line}`),
    [],
    `real-world code must stay clean, got ${JSON.stringify(report.hits, null, 2)}`
  );
});

test('PERF-LIST-FOREACH points at the loop inside the container, not a header loop', async () => {
  const root = await workspace();
  await mkdir(join(root, 'entry', 'src', 'main', 'ets'), { recursive: true });
  const page = `@Component
struct Feed {
  @State rows: string[] = []
  @State tabs: string[] = []

  build() {
    Column() {
      Row() {
        ForEach(this.tabs, (tab: string) => { Text(tab) })
      }
      List() {
        ForEach(this.rows, (row: string) => { Text(row) })
      }
    }
  }
}
`;
  await writeFile(join(root, 'entry', 'src', 'main', 'ets', 'Feed.ets'), page);

  const report = await scanWorkspace(root);
  const hits = report.hits.filter((hit) => hit.ruleId === 'PERF-LIST-FOREACH');
  assert.equal(hits.length, 1, `expected one list hit, got ${hits.length}`);
  assert.match(hits[0].excerpt, /this\.rows/, 'must point at the List loop');
  assert.equal(hits[0].line, page.split('\n').indexOf('        ForEach(this.rows, (row: string) => { Text(row) })') + 1);
});
