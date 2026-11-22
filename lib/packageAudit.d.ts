/**
 * Package / permission / privacy audit for a DevEco project.
 *
 * Facts only: declared vs referenced `ohos.permission.*`, privacy reason/scene
 * completeness, HAP size and structural signature presence. No cryptographic
 * signature verification is claimed (devecocli only generates signatures).
 *
 * @module dwguard-dsh-hmos/packageAudit
 */
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
/** Audit one project's permissions, privacy metadata, artifacts and size budget. */
export declare function auditPackage(root: string, options?: {
    maxHapMb?: number;
}): PackageAuditResult;
