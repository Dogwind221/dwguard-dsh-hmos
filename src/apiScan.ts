/**
 * Scan project sources for references to SDK APIs marked `@deprecated`.
 *
 * Read-only: parses imports of `@ohos.*` / `@kit.*`, reads the matching SDK
 * declarations for deprecated symbols, then reports every remaining call site
 * with file:line. Findings are facts; whether they fail a gate is the task pack's
 * compatibility criterion.
 *
 * @module dwguard-dsh-hmos/apiScan
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { SdkLayout } from './harmonySdk.js';
import { listDeprecatedSymbols } from './harmonySdk.js';

export interface ApiScanFinding {
  /** Project-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly module: string;
  readonly deprecated: string;
}

export interface ApiScanResult {
  readonly projectRoot: string;
  readonly filesScanned: number;
  readonly imports: readonly string[];
  readonly deprecatedSymbols: number;
  readonly findings: readonly ApiScanFinding[];
}

const SKIP_DIRS = new Set([
  'node_modules',
  'oh_modules',
  'build',
  '.hvigor',
  '.preview',
  '.git',
  '.idea',
  '.dsh-hvigor-tmp',
  'dist',
  'lib'
]);

const SOURCE_EXT = /\.(ets|ts|tsx|js|mjs|cjs|json5?)$/i;

function collectSourceFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full);
        continue;
      }
      if (SOURCE_EXT.test(entry) && info.size <= 512 * 1024) files.push(full);
    }
  };
  walk(root);
  return files;
}

function importedModules(source: string): string[] {
  const modules = new Set<string>();
  const patterns = [
    /\bfrom\s+['"](@(?:ohos|kit)\.[^'"]+)['"]/g,
    /\bimport\s+['"](@(?:ohos|kit)\.[^'"]+)['"]/g,
    /\brequire\s*\(\s*['"](@(?:ohos|kit)\.[^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const module = match[1];
      if (module !== undefined) modules.add(module);
    }
  }
  return [...modules];
}

/** Scan one project for deprecated SDK API call sites. */
export function scanDeprecatedApi(
  projectRoot: string,
  layout: SdkLayout,
  options: { maxFiles?: number; maxFindings?: number } = {}
): ApiScanResult {
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? 400, 2000));
  const maxFindings = Math.max(1, Math.min(options.maxFindings ?? 200, 1000));
  const files = collectSourceFiles(projectRoot, maxFiles);
  const imports = new Set<string>();
  const symbolsByModule = new Map<string, ReturnType<typeof listDeprecatedSymbols>>();
  const findings: ApiScanFinding[] = [];
  let filesScanned = 0;
  let deprecatedSymbols = 0;

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    filesScanned += 1;
    const modules = importedModules(source);
    for (const module of modules) imports.add(module);
    const lines = source.split('\n');
    for (const module of modules) {
      let symbols = symbolsByModule.get(module);
      if (symbols === undefined) {
        symbols = listDeprecatedSymbols(layout, module);
        symbolsByModule.set(module, symbols);
        deprecatedSymbols += symbols.length;
      }
      if (symbols.length === 0) continue;
      for (let index = 0; index < lines.length && findings.length < maxFindings; index += 1) {
        const line = lines[index] ?? '';
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        if (/^(?:import|export\s+.*\bfrom)\b/.test(trimmed)) continue;
        const commentIndex = trimmed.indexOf('//');
        for (const symbol of symbols) {
          if (findings.length >= maxFindings) break;
          if (symbol.name.length < 2) continue;
          const pattern = new RegExp(`\\b${symbol.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          const match = pattern.exec(trimmed);
          if (match === null) continue;
          if (commentIndex >= 0 && commentIndex < match.index) continue;
          const existing = findings.find(
            (entry) => entry.file === relative(projectRoot, file).split(sep).join('/') && entry.line === index + 1 && entry.symbol === symbol.name
          );
          if (existing !== undefined) continue;
          findings.push({
            file: relative(projectRoot, file).split(sep).join('/'),
            line: index + 1,
            symbol: symbol.name,
            module: symbol.module,
            deprecated: symbol.deprecated
          });
        }
      }
    }
  }

  return {
    projectRoot,
    filesScanned,
    imports: [...imports].sort(),
    deprecatedSymbols,
    findings: findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
  };
}
