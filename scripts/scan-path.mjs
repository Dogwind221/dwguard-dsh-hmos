#!/usr/bin/env node
/**
 * Scan ANY directory with the same rules as `dwguard_scan`.
 *
 * `dwguard_scan` only accepts paths inside the current DSH workspace; this
 * script is the escape hatch for trial-running the rules against a third-party
 * checkout before adopting the plugin.
 *
 *   node scripts/scan-path.mjs <dir> [<dir> ...] [--json] [--must-only]
 */
import { relative } from 'node:path';

import { scanWorkspace } from '../lib/scan.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const mustOnly = args.includes('--must-only');
const roots = args.filter((arg) => !arg.startsWith('--'));

if (roots.length === 0) {
  console.error('usage: node scripts/scan-path.mjs <dir> [<dir> ...] [--json] [--must-only]');
  process.exit(2);
}

const reports = [];
for (const root of roots) {
  try {
    const report = await scanWorkspace(root, !mustOnly);
    reports.push(report);
  } catch (error) {
    console.error(`${root}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (json) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  for (const report of reports) {
    const rel = relative(process.cwd(), report.root) || report.root;
    console.log(`\n${rel} — ${report.files} files, ${report.counts.must} must, ${report.counts.warn} warn`);
    for (const hit of report.hits) {
      console.log(`  ${hit.ruleId}  ${hit.file}:${hit.line}`);
      console.log(`      ${hit.excerpt}`);
    }
  }
}
