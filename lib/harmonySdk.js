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
function readPackageMeta(file) {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return {};
        const record = value;
        return {
            ...(typeof record['apiVersion'] === 'string' ? { apiVersion: record['apiVersion'] } : {}),
            ...(typeof record['platformVersion'] === 'string' ? { platformVersion: record['platformVersion'] } : {}),
            ...(typeof record['version'] === 'string' ? { version: record['version'] } : {})
        };
    }
    catch {
        return {};
    }
}
function firstExisting(candidates) {
    for (const candidate of candidates) {
        try {
            if (statSync(candidate).isDirectory())
                return candidate;
        }
        catch {
            continue;
        }
    }
    return undefined;
}
/**
 * Candidate SDK roots: explicit config, then environment variables, then the
 * platform default install locations. Only existing directories are returned.
 */
export function candidateSdkRoots(configured) {
    const roots = [];
    const push = (value) => {
        if (value === undefined || value.length === 0)
            return;
        const trimmed = value.trim();
        if (trimmed.length === 0)
            return;
        roots.push(resolve(trimmed));
    };
    push(configured);
    push(process.env['DEVECO_SDK_HOME']);
    push(process.env['HOS_SDK_HOME']);
    push(process.env['OHOS_SDK_HOME']);
    if (process.env['DEVECO_HOME'] !== undefined)
        push(join(process.env['DEVECO_HOME'], 'sdk'));
    if (process.env['DEVECO_CLI_STUDIO_PATH'] !== undefined)
        push(join(process.env['DEVECO_CLI_STUDIO_PATH'], 'sdk'));
    const home = homedir();
    if (process.platform === 'win32') {
        const localAppData = process.env['LOCALAPPDATA'];
        if (localAppData !== undefined) {
            push(join(localAppData, 'Huawei', 'Sdk'));
            push(join(localAppData, 'Huawei', 'DevEcoStudio', 'sdk'));
        }
        push(join(home, 'AppData', 'Local', 'Huawei', 'Sdk'));
        push(join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Huawei', 'DevEco Studio', 'sdk'));
    }
    else if (process.platform === 'darwin') {
        push(join(home, 'Library', 'Huawei', 'Sdk'));
        push(join(home, 'Library', 'OpenHarmony', 'Sdk'));
        push('/Applications/DevEco-Studio.app/Contents/sdk');
    }
    else {
        push(join(home, 'Huawei', 'Sdk'));
        push(join(home, 'OpenHarmony', 'Sdk'));
        push('/opt/huawei/sdk');
    }
    const seen = new Set();
    const existing = [];
    for (const root of roots) {
        if (seen.has(root))
            continue;
        seen.add(root);
        try {
            if (statSync(root).isDirectory())
                existing.push(root);
        }
        catch {
            continue;
        }
    }
    return existing;
}
function layoutAt(root) {
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
        if (!existsSync(variant.apiDir))
            continue;
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
export function findSdkLayout(configured) {
    for (const root of candidateSdkRoots(configured)) {
        const layout = layoutAt(root);
        if (layout !== null)
            return layout;
    }
    return null;
}
/** List module names available in one SDK registry (`api` or `kits`). */
export function listSdkModules(layout, kind) {
    const dir = kind === 'kit'
        ? layout.kitsDir ?? layout.hmsKitsDir
        : kind === 'hms'
            ? layout.hmsApiDir
            : layout.apiDir;
    if (dir === undefined)
        return [];
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return [];
    }
    return entries
        .filter((entry) => entry.endsWith('.d.ts'))
        .map((entry) => entry.slice(0, -'.d.ts'.length))
        .sort();
}
function normalizeModuleName(raw) {
    const name = raw.trim();
    if (name.startsWith('@kit.'))
        return name;
    if (name.startsWith('kit.'))
        return `@${name}`;
    if (name.startsWith('@ohos.'))
        return name;
    if (name.startsWith('ohos.'))
        return `@${name}`;
    if (name.startsWith('@'))
        return name;
    return name;
}
function locateDeclarations(layout, moduleName) {
    const fileNames = [`${moduleName}.d.ts`];
    const registries = [
        { dir: layout.kitsDir, kind: 'kit' },
        { dir: layout.hmsKitsDir, kind: 'kit' },
        { dir: layout.apiDir, kind: 'openharmony' },
        { dir: layout.hmsApiDir, kind: 'hms' }
    ];
    for (const registry of registries) {
        if (registry.dir === undefined)
            continue;
        for (const fileName of fileNames) {
            const candidate = join(registry.dir, fileName);
            if (existsSync(candidate))
                return { file: candidate, kind: registry.kind };
        }
    }
    // Prefix fallback: e.g. `@ohos.arkui.` resolves to `@ohos.arkui.component.d.ts`.
    for (const registry of registries) {
        if (registry.dir === undefined)
            continue;
        let entries;
        try {
            entries = readdirSync(registry.dir);
        }
        catch {
            continue;
        }
        const prefix = `${moduleName}.`;
        const match = entries.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.d.ts')).sort();
        const first = match[0];
        if (first !== undefined)
            return { file: join(registry.dir, first), kind: registry.kind };
    }
    return null;
}
/** Read a module's declaration file and extract tags + declaration lines. */
export function lookupSdkApi(layout, rawModule, nameFilter) {
    const moduleName = normalizeModuleName(rawModule);
    if (!/^[@\w.]+$/.test(moduleName))
        return null;
    const located = locateDeclarations(layout, moduleName);
    if (located === null)
        return null;
    let info;
    try {
        info = statSync(located.file);
    }
    catch {
        return null;
    }
    // SDK declarations can be large; cap the read so a hostile file cannot exhaust memory.
    if (info.size > 4 * 1024 * 1024)
        return null;
    let text;
    try {
        text = readFileSync(located.file, 'utf8');
    }
    catch {
        return null;
    }
    const lines = text.split('\n');
    const tags = [];
    const tagPattern = /@(since|deprecated|syscap|crossplatform|stagemodelonly|atomicservice|form|systemapi|kit)\b\s*(.*)$/;
    const seenTags = new Set();
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const match = tagPattern.exec(line.trim());
        if (match === null)
            continue;
        const tag = `@${match[1] ?? ''}`;
        const value = (match[2] ?? '').trim();
        const key = `${tag} ${value}`;
        if (seenTags.has(key))
            continue;
        seenTags.add(key);
        tags.push({ tag, value, line: index + 1 });
        if (tags.length >= 40)
            break;
    }
    const declarations = [];
    const declarationPattern = /^(?:declare|export|interface|class|function|type|enum|namespace)\b/;
    for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] ?? '').trim();
        if (!declarationPattern.test(line))
            continue;
        if (line.startsWith('export *') || line.startsWith('export {'))
            continue;
        if (nameFilter !== undefined && nameFilter.length > 0 && !line.includes(nameFilter))
            continue;
        declarations.push(`L${index + 1}: ${line}`);
        if (declarations.length >= 40)
            break;
    }
    return { module: moduleName, file: located.file, kind: located.kind, tags, declarations };
}
