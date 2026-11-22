/**
 * Read-only introspection of a DevEco / HarmonyOS project layout.
 *
 * The `project` action answers "what is this project?" without building it:
 * bundle identity, SDK versions, products/build modes, modules, abilities,
 * permissions, page tables, dependencies and existing HAP artifacts. It only
 * reads files; nothing is executed and nothing outside `root` is touched.
 *
 * DevEco config files are JSON5 (comments, trailing commas). A tiny tolerant
 * reader lives here instead of adding a dependency.
 *
 * @module dwguard-dsh-hmos/harmonyProject
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
function readText(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
}
/**
 * Strip JSON5 comments and trailing commas, leaving a JSON.parse-compatible
 * string. String literals (including escaped quotes) are preserved verbatim.
 */
export function stripJson5(text) {
    const out = [];
    let inString = null;
    let escaped = false;
    let i = 0;
    const len = text.length;
    while (i < len) {
        const ch = text.charAt(i);
        if (inString !== null) {
            out.push(ch);
            if (escaped)
                escaped = false;
            else if (ch === '\\')
                escaped = true;
            else if (ch === inString)
                inString = null;
            i += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = ch;
            out.push(ch);
            i += 1;
            continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '/') {
            while (i < len && text.charAt(i) !== '\n')
                i += 1;
            continue;
        }
        if (ch === '/' && text.charAt(i + 1) === '*') {
            i += 2;
            while (i < len && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/'))
                i += 1;
            i = Math.min(i + 2, len);
            continue;
        }
        if (ch === ',') {
            // Drop the comma only when the next significant character closes an object/array.
            let j = i + 1;
            while (j < len) {
                const next = text.charAt(j);
                if (next === ' ' || next === '\t' || next === '\r' || next === '\n') {
                    j += 1;
                    continue;
                }
                if (next === '/' && text.charAt(j + 1) === '/') {
                    while (j < len && text.charAt(j) !== '\n')
                        j += 1;
                    continue;
                }
                if (next === '/' && text.charAt(j + 1) === '*') {
                    j += 2;
                    while (j < len && !(text.charAt(j) === '*' && text.charAt(j + 1) === '/'))
                        j += 1;
                    j += 2;
                    continue;
                }
                break;
            }
            if (j < len && (text.charAt(j) === '}' || text.charAt(j) === ']')) {
                i += 1;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    return out.join('');
}
/** Parse a JSON5-ish object file; `null` when missing or unparseable. */
export function readJson5Object(file) {
    const raw = readText(file);
    if (raw === null)
        return null;
    try {
        const value = JSON.parse(stripJson5(raw));
        if (typeof value !== 'object' || value === null || Array.isArray(value))
            return null;
        return value;
    }
    catch {
        return null;
    }
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : null;
}
function recordArray(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        const itemRecord = record(item);
        if (itemRecord !== null)
            out.push(itemRecord);
    }
    return out;
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.trim().length > 0);
}
function scalarString(value) {
    if (typeof value === 'string' && value.trim().length > 0)
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
/**
 * Find the project root: `start` itself, or its single child directory that
 * carries `build-profile.json5` (e.g. a workspace containing one app folder).
 */
export function findProjectRoot(start) {
    if (existsSync(join(start, 'build-profile.json5')))
        return start;
    let entries;
    try {
        entries = readdirSync(start);
    }
    catch {
        return null;
    }
    const hits = [];
    for (const entry of entries) {
        const candidate = join(start, entry);
        try {
            if (!statSync(candidate).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        if (existsSync(join(candidate, 'build-profile.json5')))
            hits.push(candidate);
    }
    return hits.length === 1 ? hits[0] ?? null : null;
}
function readModuleInfo(root, entry) {
    const name = scalarString(entry['name']) ?? '';
    if (name.length === 0)
        return null;
    const srcPath = scalarString(entry['srcPath']) ?? name;
    const moduleDir = join(root, srcPath);
    const moduleJson = readJson5Object(join(moduleDir, 'src', 'main', 'module.json5')) ?? readJson5Object(join(moduleDir, 'module.json5'));
    const moduleBody = record(moduleJson?.['module']) ?? moduleJson ?? {};
    const abilities = recordArray(moduleBody['abilities'])
        .map((ability) => scalarString(ability['name']) ?? '')
        .filter((value) => value.length > 0);
    const permissions = recordArray(moduleBody['requestPermissions'])
        .map((permission) => scalarString(permission['name']) ?? '')
        .filter((value) => value.length > 0);
    const deviceTypes = stringArray(moduleBody['deviceTypes']);
    let pages = [];
    const pagesProfile = readText(join(moduleDir, 'src', 'main', 'resources', 'base', 'profile', 'main_pages.json'));
    if (pagesProfile !== null) {
        try {
            const parsed = JSON.parse(pagesProfile);
            const parsedRecord = record(parsed);
            if (parsedRecord !== null)
                pages = stringArray(parsedRecord['src']);
        }
        catch {
            pages = [];
        }
    }
    return {
        name,
        type: scalarString(moduleBody['type']) ?? 'unknown',
        srcPath,
        deviceTypes,
        abilities,
        permissions,
        pages
    };
}
function collectArtifacts(root, maxDepth = 6, limit = 20) {
    const skip = new Set(['node_modules', 'oh_modules', '.git', '.hvigor', '.preview', '.idea', '.dsh-hvigor-tmp']);
    const found = [];
    const walk = (dir, depth) => {
        if (depth > maxDepth || found.length >= limit)
            return;
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (found.length >= limit)
                return;
            if (skip.has(entry))
                continue;
            const file = join(dir, entry);
            let info;
            try {
                info = statSync(file);
            }
            catch {
                continue;
            }
            if (info.isDirectory()) {
                walk(file, depth + 1);
                continue;
            }
            if (!/\.(hap|hsp|app)$/i.test(entry))
                continue;
            found.push({ path: relative(root, file).split(sep).join('/'), bytes: info.size });
        }
    };
    walk(root, 0);
    return found;
}
/** Read the project summary under `root`. */
export function readProjectInfo(root) {
    const buildProfile = readJson5Object(join(root, 'build-profile.json5')) ?? {};
    const appBlock = record(buildProfile['app']) ?? {};
    const appJson = readJson5Object(join(root, 'AppScope', 'app.json5')) ?? readJson5Object(join(root, 'app.json5')) ?? {};
    const appBody = record(appJson['app']) ?? appJson;
    const products = recordArray(appBlock['products']);
    const firstProduct = products[0] ?? {};
    const compileVersion = scalarString(firstProduct['compileSdkVersion']);
    const compatibleVersion = scalarString(firstProduct['compatibleSdkVersion']);
    const targetVersion = scalarString(firstProduct['targetSdkVersion']);
    const runtimeOS = scalarString(firstProduct['runtimeOS']);
    const apiVersions = {
        ...(compileVersion === undefined ? {} : { compileSdkVersion: compileVersion }),
        ...(compatibleVersion === undefined ? {} : { compatibleSdkVersion: compatibleVersion }),
        ...(targetVersion === undefined ? {} : { targetSdkVersion: targetVersion }),
        ...(runtimeOS === undefined ? {} : { runtimeOS })
    };
    const modules = [];
    for (const entry of recordArray(buildProfile['modules'])) {
        const info = readModuleInfo(root, entry);
        if (info !== null)
            modules.push(info);
    }
    const packageJson = readJson5Object(join(root, 'oh-package.json5')) ?? {};
    const dependencies = [
        ...Object.keys(record(packageJson['dependencies']) ?? {}),
        ...Object.keys(record(packageJson['devDependencies']) ?? {})
    ].sort();
    const signingConfigs = recordArray(appBlock['signingConfigs'])
        .map((config) => scalarString(config['name']) ?? '')
        .filter((value) => value.length > 0);
    return {
        root,
        ...(scalarString(appBody['bundleName']) === undefined ? {} : { bundleName: scalarString(appBody['bundleName']) }),
        ...(scalarString(appBody['versionName']) === undefined ? {} : { versionName: scalarString(appBody['versionName']) }),
        ...(scalarString(appBody['versionCode']) === undefined
            ? {}
            : { versionCode: scalarString(appBody['versionCode']) }),
        ...(scalarString(appBody['vendor']) === undefined ? {} : { vendor: scalarString(appBody['vendor']) }),
        ...(scalarString(appBody['label']) === undefined ? {} : { appLabel: scalarString(appBody['label']) }),
        products: products
            .map((product) => scalarString(product['name']) ?? '')
            .filter((value) => value.length > 0),
        buildModes: recordArray(appBlock['buildModeSet'])
            .map((mode) => scalarString(mode['name']) ?? '')
            .filter((value) => value.length > 0),
        signingConfigs,
        apiVersions,
        modules,
        dependencies,
        artifacts: collectArtifacts(root)
    };
}
/** Resolve `dir` under `workspace` and reject escapes. */
export function resolveInside(workspace, dir) {
    const target = resolve(workspace, dir);
    if (target !== workspace && !target.startsWith(`${workspace}${sep}`))
        return null;
    return target;
}
