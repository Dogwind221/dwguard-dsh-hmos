/**
 * Local HarmonyOS SDK lookup: locate an installed SDK, find a module's `.d.ts`
 * declaration and read its documentation tags (`@since`, `@deprecated`,
 * `@syscap`...). Read-only: nothing is downloaded, nothing is executed.
 *
 * @module dwguard-dsh-hmos/harmonySdk
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** One installed SDK that can answer API questions. */
export interface SdkLayout {
  readonly root: string;
  /** OpenHarmony `ets/api` directory (declares `@ohos.*`). */
  readonly apiDir: string;
  /** OpenHarmony `ets/kits` directory (declares `@kit.*`). */
  readonly kitsDir?: string;
  /** HMS `ets/api` directory. */
  readonly hmsApiDir?: string;
  /** HMS `ets/kits` directory (declares HMS `@kit.*`). */
  readonly hmsKitsDir?: string;
  readonly apiVersion?: string;
  readonly platformVersion?: string;
  readonly sdkVersion?: string;
}

interface PackageMeta {
  apiVersion?: string;
  platformVersion?: string;
  version?: string;
}

function readPackageMeta(file: string): PackageMeta {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record['apiVersion'] === 'string' ? { apiVersion: record['apiVersion'] } : {}),
      ...(typeof record['platformVersion'] === 'string' ? { platformVersion: record['platformVersion'] } : {}),
      ...(typeof record['version'] === 'string' ? { version: record['version'] } : {})
    };
  } catch {
    return {};
  }
}

function firstExisting(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Candidate SDK roots: explicit config, then environment variables, then the
 * platform default install locations. Only existing directories are returned.
 */
export function candidateSdkRoots(configured: string): string[] {
  const roots: string[] = [];
  const push = (value: string | undefined): void => {
    if (value === undefined || value.length === 0) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    roots.push(resolve(trimmed));
  };
  push(configured);
  push(process.env['DEVECO_SDK_HOME']);
  push(process.env['HOS_SDK_HOME']);
  push(process.env['OHOS_SDK_HOME']);
  if (process.env['DEVECO_HOME'] !== undefined) push(join(process.env['DEVECO_HOME'], 'sdk'));
  if (process.env['DEVECO_CLI_STUDIO_PATH'] !== undefined) push(join(process.env['DEVECO_CLI_STUDIO_PATH'], 'sdk'));
  const home = homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData !== undefined) {
      push(join(localAppData, 'Huawei', 'Sdk'));
      push(join(localAppData, 'Huawei', 'DevEcoStudio', 'sdk'));
    }
    push(join(home, 'AppData', 'Local', 'Huawei', 'Sdk'));
    push(join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Huawei', 'DevEco Studio', 'sdk'));
  } else if (process.platform === 'darwin') {
    push(join(home, 'Library', 'Huawei', 'Sdk'));
    push(join(home, 'Library', 'OpenHarmony', 'Sdk'));
    push('/Applications/DevEco-Studio.app/Contents/sdk');
  } else {
    push(join(home, 'Huawei', 'Sdk'));
    push(join(home, 'OpenHarmony', 'Sdk'));
    push('/opt/huawei/sdk');
  }
  const seen = new Set<string>();
  const existing: string[] = [];
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      if (statSync(root).isDirectory()) existing.push(root);
    } catch {
      continue;
    }
  }
  return existing;
}

function layoutAt(root: string): SdkLayout | null {
  const variants = [
    {
      apiDir: join(root, 'default', 'openharmony', 'ets', 'api'),
      kitsDir: join(root, 'default', 'openharmony', 'ets', 'kits'),
      hmsApiDir: join(root, 'default', 'hms', 'ets', 'api'),
      hmsKitsDir: join(root, 'default', 'hms', 'ets', 'kits'),
      versionFile: join(root, 'default', 'openharmony', 'ets', 'oh-uni-package.json')
    },
    {
      apiDir: join(root, 'openharmony', 'ets', 'api'),
      kitsDir: join(root, 'openharmony', 'ets', 'kits'),
      hmsApiDir: join(root, 'hms', 'ets', 'api'),
      hmsKitsDir: join(root, 'hms', 'ets', 'kits'),
      versionFile: join(root, 'openharmony', 'ets', 'oh-uni-package.json')
    },
    {
      apiDir: join(root, 'ets', 'api'),
      kitsDir: join(root, 'ets', 'kits'),
      hmsApiDir: join(root, 'hms', 'ets', 'api'),
      hmsKitsDir: join(root, 'hms', 'ets', 'kits'),
      versionFile: join(root, 'ets', 'oh-uni-package.json')
    }
  ];
  for (const variant of variants) {
    if (!existsSync(variant.apiDir)) continue;
    const kitsDir = firstExisting([variant.kitsDir]);
    const hmsApiDir = firstExisting([variant.hmsApiDir]);
    const hmsKitsDir = firstExisting([variant.hmsKitsDir]);
    const meta = readPackageMeta(variant.versionFile);
    return {
      root,
      apiDir: variant.apiDir,
      ...(kitsDir === undefined ? {} : { kitsDir }),
      ...(hmsApiDir === undefined ? {} : { hmsApiDir }),
      ...(hmsKitsDir === undefined ? {} : { hmsKitsDir }),
      ...(meta.apiVersion === undefined ? {} : { apiVersion: meta.apiVersion }),
      ...(meta.platformVersion === undefined ? {} : { platformVersion: meta.platformVersion }),
      ...(meta.version === undefined ? {} : { sdkVersion: meta.version })
    };
  }
  return null;
}

/** Find the first installed SDK that has the OpenHarmony `ets/api` tree. */
export function findSdkLayout(configured: string): SdkLayout | null {
  for (const root of candidateSdkRoots(configured)) {
    const layout = layoutAt(root);
    if (layout !== null) return layout;
  }
  return null;
}

/** List module names available in one SDK registry (`api` or `kits`). */
export function listSdkModules(layout: SdkLayout, kind: 'openharmony' | 'hms' | 'kit'): string[] {
  const dir =
    kind === 'kit'
      ? layout.kitsDir ?? layout.hmsKitsDir
      : kind === 'hms'
        ? layout.hmsApiDir
        : layout.apiDir;
  if (dir === undefined) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.d.ts'))
    .map((entry) => entry.slice(0, -'.d.ts'.length))
    .sort();
}

function normalizeModuleName(raw: string): string {
  const name = raw.trim();
  if (name.startsWith('@kit.')) return name;
  if (name.startsWith('kit.')) return `@${name}`;
  if (name.startsWith('@ohos.')) return name;
  if (name.startsWith('ohos.')) return `@${name}`;
  if (name.startsWith('@')) return name;
  return name;
}

interface LocatedFile {
  readonly file: string;
  readonly kind: 'openharmony' | 'hms' | 'kit';
}

function locateDeclarations(layout: SdkLayout, moduleName: string): LocatedFile | null {
  const fileNames = [`${moduleName}.d.ts`];
  const registries: Array<{ dir: string | undefined; kind: 'openharmony' | 'hms' | 'kit' }> = [
    { dir: layout.kitsDir, kind: 'kit' },
    { dir: layout.hmsKitsDir, kind: 'kit' },
    { dir: layout.apiDir, kind: 'openharmony' },
    { dir: layout.hmsApiDir, kind: 'hms' }
  ];
  for (const registry of registries) {
    if (registry.dir === undefined) continue;
    for (const fileName of fileNames) {
      const candidate = join(registry.dir, fileName);
      if (existsSync(candidate)) return { file: candidate, kind: registry.kind };
    }
  }
  // Prefix fallback: e.g. `@ohos.arkui.` resolves to `@ohos.arkui.component.d.ts`.
  for (const registry of registries) {
    if (registry.dir === undefined) continue;
    let entries: string[];
    try {
      entries = readdirSync(registry.dir);
    } catch {
      continue;
    }
    const prefix = `${moduleName}.`;
    const match = entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.d.ts')).sort();
    const first = match[0];
    if (first !== undefined) return { file: join(registry.dir, first), kind: registry.kind };
  }
  return null;
}

/** One documentation tag found in a declaration file. */
export interface ApiTag {
  readonly tag: string;
  readonly value: string;
  readonly line: number;
}

/** A single API declaration marked `@deprecated`. */
export interface DeprecatedSymbol {
  readonly module: string;
  readonly name: string;
  readonly since?: string;
  readonly deprecated: string;
}

const DECLARATION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:function|interface|class|type|enum|const|let|var|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*\(/
];

/**
 * List declarations marked `@deprecated` in one SDK module's `.d.ts`.
 * Read-only and capped, so a scan over a project import set stays cheap.
 */
export function listDeprecatedSymbols(layout: SdkLayout, rawModule: string): DeprecatedSymbol[] {
  const moduleName = normalizeModuleName(rawModule);
  if (!/^[@\w.]+$/.test(moduleName)) return [];
  const located = locateDeclarations(layout, moduleName);
  if (located === null) return [];
  let info;
  try {
    info = statSync(located.file);
  } catch {
    return [];
  }
  if (info.size > 4 * 1024 * 1024) return [];
  let text: string;
  try {
    text = readFileSync(located.file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  const symbols: DeprecatedSymbol[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /@deprecated\b\s*(.*)$/.exec(line);
    if (match === null) continue;
    let since: string | undefined;
    for (let lookBack = Math.max(0, index - 12); lookBack < index; lookBack += 1) {
      const sinceMatch = /@since\b\s*(.*)$/.exec(lines[lookBack] ?? '');
      if (sinceMatch !== null) {
        since = (sinceMatch[1] ?? '').trim();
        break;
      }
    }
    const deprecated = (match[1] ?? '').trim().length === 0 ? 'deprecated' : (match[1] ?? '').trim().slice(0, 200);
    for (let lookAhead = index + 1; lookAhead < Math.min(lines.length, index + 30); lookAhead += 1) {
      const candidate = lines[lookAhead] ?? '';
      const declaration = DECLARATION_PATTERNS.map((pattern) => pattern.exec(candidate)).find((entry) => entry !== null);
      if (declaration === undefined) continue;
      const name = declaration[1];
      if (name === undefined || name.length < 2 || seen.has(name)) break;
      seen.add(name);
      symbols.push({ module: moduleName, name, ...(since === undefined ? {} : { since }), deprecated });
      break;
    }
    if (symbols.length >= 200) break;
  }
  return symbols;
}

/** Result of one SDK API lookup. */
export interface ApiLookup {
  readonly module: string;
  readonly file: string;
  readonly kind: 'openharmony' | 'hms' | 'kit';
  readonly tags: readonly ApiTag[];
  readonly declarations: readonly string[];
}

/** Read a module's declaration file and extract tags + declaration lines. */
export function lookupSdkApi(layout: SdkLayout, rawModule: string, nameFilter?: string): ApiLookup | null {
  const moduleName = normalizeModuleName(rawModule);
  if (!/^[@\w.]+$/.test(moduleName)) return null;
  const located = locateDeclarations(layout, moduleName);
  if (located === null) return null;
  let info;
  try {
    info = statSync(located.file);
  } catch {
    return null;
  }
  // SDK declarations can be large; cap the read so a hostile file cannot exhaust memory.
  if (info.size > 4 * 1024 * 1024) return null;
  let text: string;
  try {
    text = readFileSync(located.file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const tags: ApiTag[] = [];
  const tagPattern = /@(since|deprecated|syscap|crossplatform|stagemodelonly|atomicservice|form|systemapi|kit)\b\s*(.*)$/;
  const seenTags = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = tagPattern.exec(line.trim());
    if (match === null) continue;
    const tag = `@${match[1] ?? ''}`;
    const value = (match[2] ?? '').trim();
    const key = `${tag} ${value}`;
    if (seenTags.has(key)) continue;
    seenTags.add(key);
    tags.push({ tag, value, line: index + 1 });
    if (tags.length >= 40) break;
  }
  const declarations: string[] = [];
  const declarationPattern = /^(?:declare|export|interface|class|function|type|enum|namespace)\b/;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (!declarationPattern.test(line)) continue;
    if (line.startsWith('export *') || line.startsWith('export {')) continue;
    if (nameFilter !== undefined && nameFilter.length > 0 && !line.includes(nameFilter)) continue;
    declarations.push(`L${index + 1}: ${line}`);
    if (declarations.length >= 40) break;
  }
  return { module: moduleName, file: located.file, kind: located.kind, tags, declarations };
}
