/**
 * Package / permission / privacy audit for a DevEco project.
 *
 * Facts only: declared vs referenced `ohos.permission.*`, privacy reason/scene
 * completeness, HAP size and structural signature presence. No cryptographic
 * signature verification is claimed (devecocli only generates signatures).
 *
 * @module dwguard-dsh-hmos/packageAudit
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { readJson5Object, readProjectInfo } from './harmonyProject.js';

export interface DeclaredPermission {
  readonly name: string;
  readonly module: string;
  readonly reason?: string;
  readonly usedScene?: string;
}

export interface PackageAuditFinding {
  readonly kind: 'permission-missing-declaration' | 'permission-unused' | 'privacy-missing-reason' | 'size-budget' | 'signature';
  readonly severity: 'blocker' | 'major' | 'minor' | 'info';
  readonly message: string;
}

export interface ArtifactAudit {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly structurallySigned: boolean;
  readonly signatureFiles: readonly string[];
}

export interface PackageAuditResult {
  readonly projectRoot: string;
  readonly declared: readonly DeclaredPermission[];
  readonly referenced: readonly string[];
  readonly missingDeclaration: readonly string[];
  readonly unusedDeclaration: readonly string[];
  readonly privacyMissing: readonly DeclaredPermission[];
  readonly artifacts: readonly ArtifactAudit[];
  readonly maxHapMb?: number;
  readonly findings: readonly PackageAuditFinding[];
  readonly scannedFiles: number;
}

const SKIP_DIRS = new Set(['node_modules', 'oh_modules', 'build', '.hvigor', '.preview', '.git', '.idea', 'dist', 'lib']);
const SOURCE_EXT = /\.(ets|ts|tsx|js|mjs|cjs)$/i;

function collectSourceFiles(root: string, maxFiles = 600): string[] {
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
      if (files.length >= maxFiles || SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(full);
      else if (SOURCE_EXT.test(entry) && info.size <= 512 * 1024) files.push(full);
    }
  };
  walk(root);
  return files;
}

function declaredPermissions(root: string): DeclaredPermission[] {
  const out: DeclaredPermission[] = [];
  const project = readProjectInfo(root);
  for (const module of project.modules) {
    const file = join(root, module.srcPath, 'src', 'main', 'module.json5');
    const json = readJson5Object(file) ?? readJson5Object(join(root, module.srcPath, 'module.json5'));
    const body = json !== null && typeof json['module'] === 'object' && json['module'] !== null
      ? (json['module'] as Record<string, unknown>)
      : json;
    if (body === null) continue;
    const rows = Array.isArray(body['requestPermissions']) ? body['requestPermissions'] : [];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as Record<string, unknown>;
      const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
      if (name.length === 0) continue;
      const usedScene = record['usedScene'];
      out.push({
        name,
        module: module.name,
        ...(typeof record['reason'] === 'string' && record['reason'].trim().length > 0
          ? { reason: record['reason'].trim() }
          : {}),
        ...(usedScene === undefined || usedScene === null
          ? {}
          : { usedScene: typeof usedScene === 'string' ? usedScene : JSON.stringify(usedScene).slice(0, 200) })
      });
    }
  }
  return out;
}

function referencedPermissions(root: string): { referenced: string[]; scannedFiles: number } {
  const found = new Set<string>();
  const files = collectSourceFiles(root);
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/\bohos\.permission\.[A-Za-z0-9_]+/g)) {
      found.add(match[0]);
    }
  }
  return { referenced: [...found].sort(), scannedFiles: files.length };
}

function artifactAudit(root: string, maxHapMb: number | undefined): { artifacts: ArtifactAudit[]; findings: PackageAuditFinding[] } {
  const project = readProjectInfo(root);
  const artifacts: ArtifactAudit[] = [];
  const findings: PackageAuditFinding[] = [];
  for (const artifact of project.artifacts.slice(0, 20)) {
    const file = join(root, artifact.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    const signatureFiles: string[] = [];
    const source = bytes.toString('latin1');
    for (const match of source.matchAll(/META-INF\/[A-Za-z0-9_.-]+\.(RSA|EC|DSA|SF)/g)) {
      if (signatureFiles.length < 10) signatureFiles.push(match[0]);
    }
    const structurallySigned = signatureFiles.some((entry) => /\.(RSA|EC|DSA|SF)$/.test(entry));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const mb = bytes.length / (1024 * 1024);
    artifacts.push({
      path: relative(root, file).split(sep).join('/'),
      bytes: bytes.length,
      sha256,
      structurallySigned,
      signatureFiles
    });
    if (!structurallySigned) {
      findings.push({
        kind: 'signature',
        severity: 'major',
        message: `产物 ${artifact.path} 未发现 META-INF 签名文件（结构性检查，非密码学验签）`
      });
    }
    if (maxHapMb !== undefined && maxHapMb > 0 && mb > maxHapMb) {
      findings.push({
        kind: 'size-budget',
        severity: 'major',
        message: `产物 ${artifact.path} 为 ${mb.toFixed(2)}MB，超过预算 ${String(maxHapMb)}MB`
      });
    }
  }
  return { artifacts, findings };
}

/** Audit one project's permissions, privacy metadata, artifacts and size budget. */
export function auditPackage(root: string, options: { maxHapMb?: number } = {}): PackageAuditResult {
  const declared = declaredPermissions(root);
  const { referenced, scannedFiles } = referencedPermissions(root);
  const declaredNames = new Set(declared.map((entry) => entry.name));
  const referencedNames = new Set(referenced);
  const missingDeclaration = referenced.filter((name) => !declaredNames.has(name));
  const unusedDeclaration = declared.map((entry) => entry.name).filter((name) => !referencedNames.has(name));
  const privacyMissing = declared.filter((entry) => entry.reason === undefined || entry.usedScene === undefined);
  const { artifacts, findings: artifactFindings } = artifactAudit(root, options.maxHapMb);
  const findings: PackageAuditFinding[] = [
    ...missingDeclaration.map((name): PackageAuditFinding => ({
      kind: 'permission-missing-declaration',
      severity: 'blocker',
      message: `源码引用了未声明的权限：${name}`
    })),
    ...unusedDeclaration.map((name): PackageAuditFinding => ({
      kind: 'permission-unused',
      severity: 'minor',
      message: `声明了但源码未引用的权限：${name}`
    })),
    ...privacyMissing.map((entry): PackageAuditFinding => ({
      kind: 'privacy-missing-reason',
      severity: 'major',
      message: `权限 ${entry.name}（${entry.module}）缺少 reason 或 usedScene`
    })),
    ...artifactFindings
  ];
  return {
    projectRoot: root,
    declared,
    referenced,
    missingDeclaration,
    unusedDeclaration,
    privacyMissing,
    artifacts,
    ...(options.maxHapMb === undefined ? {} : { maxHapMb: options.maxHapMb }),
    findings,
    scannedFiles
  };
}
