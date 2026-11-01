/**
 * Independent ArkTS/ArkUI static scan.
 *
 * The audit must not rely on "I read the code": these checks run over the
 * workspace and turn the highest-frequency ArkTS/ArkUI mistakes (LLM写鸿蒙的
 * 老坑) into rule-ID findings with file:line evidence. Deliberately small and
 * dependency-free — the goal is a defensible baseline, not a full linter.
 *
 * @module dwguard-dsh-hmos/scan
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
const SKIP_DIRS = new Set([
    'node_modules',
    'oh_modules',
    'build',
    'dist',
    '.git',
    '.shared',
    '.hvigor',
    'hvigor',
    '.idea'
]);
const MAX_FILES = 600;
const MAX_BYTES = 512 * 1024;
const EXTENSIONS = new Set(['.ets', '.ts']);
const V1_DECORATORS = /@(State|Prop|Link|Provide|Consume|Observed|ObjectLink|Watch)\b/;
const V2_DECORATORS = /@(ObservedV2|Trace|Local|Param|Once|Event|Provider|Consumer)\b/;
const STATE_DECLARATION = /@State\s+(?:private\s+)?([A-Za-z_$][\w$]*)\s*:\s*([^\n=;]+)/g;
const ANY_RULE = /(:\s*any\b|as\s+any\b|<any>)/;
const OHOS_MODULE = /from\s+['"]@ohos\./;
const FAKE_PACKAGE = /from\s+['"]@ohos\/(dayjs|uuid|lodash|moment|rxjs|react|vue|axios2)['"]/;
const LAZY_LIST = /(List|Grid|WaterFlow)\s*\(/;
const TIMER_SET = /setInterval\s*\(/;
const TIMER_CLEAR = /clearInterval\s*\(/;
const BUTTON_OR_CLICK = /(Button\s*\(|\.onClick\s*\()/;
const A11Y_TEXT = /(accessibilityText\s*\(|accessibilityDescription\s*\(|accessibilityGroup\s*\()/;
const RULES = {
    'STATE-NESTED-01': {
        dimension: 'function',
        severity: 'must',
        message: '嵌套属性被直接赋值，状态框架观察不到，不会触发 UI 刷新',
        suggestion: '整体替换：对象用 `this.user = { ...this.user, name }`，数组项用 `this.items[i] = { ...this.items[i], name }`；@State 数组本身的 push/pop 是可观察的，不用改。'
    },
    'ARKTS-ANY-001': {
        dimension: 'function',
        severity: 'must',
        message: 'ArkTS 严格模式禁止 any',
        suggestion: '给参数/返回值/字段补精确类型，必要时用 `unknown` + 类型守卫。'
    },
    'ARKTS-IMPORT-KIT': {
        dimension: 'function',
        severity: 'must',
        message: '使用了旧式 `@ohos.*` 模块导入',
        suggestion: '改成 `@kit.*`（如 `import { UIAbility } from \'@kit.AbilityKit\'`）。'
    },
    'ARKTS-V1V2-MIX': {
        dimension: 'function',
        severity: 'must',
        message: '同一文件混用 V1（@State 等）与 V2（@ObservedV2/@Local 等）状态装饰器',
        suggestion: '一个文件二选一；新代码默认 V1，V2 只在明确需要时使用。'
    },
    'OHPM-FAKE-001': {
        dimension: 'function',
        severity: 'must',
        message: '疑似 OHPM 伪包名（该包在 OHPM 上不存在）',
        suggestion: '先在 https://ohpm.openharmony.cn/ 核验包名；不要按 npm 习惯臆造 `@ohos/*`。'
    },
    'PERF-LIST-FOREACH': {
        dimension: 'performance',
        severity: 'warn',
        message: '列表容器内使用 ForEach 且未用 LazyForEach',
        suggestion: '长列表改用 `LazyForEach` + `IDataSource`，避免一次性构建全部子组件。'
    },
    'LIFECYCLE-TIMER': {
        dimension: 'performance',
        severity: 'warn',
        message: '文件里 setInterval 没有配对的 clearInterval',
        suggestion: '在 `aboutToDisappear` 里清理定时器，避免页面销毁后仍在跑。'
    },
    'A11Y-TEXT-001': {
        dimension: 'accessibility',
        severity: 'warn',
        message: '可点击组件没有无障碍文本',
        suggestion: '给按钮/可点击区域补 `.accessibilityText(...)`，图标按钮尤其必要。'
    }
};
function hit(ruleId, file, line, excerpt) {
    const rule = RULES[ruleId];
    return {
        ruleId,
        dimension: rule.dimension,
        severity: rule.severity,
        file,
        line,
        excerpt: excerpt.trim().slice(0, 160),
        message: rule.message,
        suggestion: rule.suggestion
    };
}
function isComment(line) {
    const trimmed = line.trimStart();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}
async function collectFiles(root, sinceMs) {
    const files = [];
    const walk = async (dir) => {
        if (files.length >= MAX_FILES)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= MAX_FILES)
                return;
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name))
                    continue;
                await walk(join(dir, entry.name));
                continue;
            }
            if (!entry.isFile())
                continue;
            const extension = entry.name.slice(entry.name.lastIndexOf('.'));
            if (!EXTENSIONS.has(extension))
                continue;
            const path = join(dir, entry.name);
            try {
                const info = await stat(path);
                if (info.size > MAX_BYTES)
                    continue;
                // Incremental mode: only files touched since the last shadow round.
                if (sinceMs !== undefined && info.mtimeMs < sinceMs)
                    continue;
            }
            catch {
                continue;
            }
            files.push(path);
        }
    };
    await walk(root);
    return files;
}
/**
 * Scan one workspace for ArkTS/ArkUI pitfalls.
 * @param root - absolute directory to scan.
 * @param includeWarnings - include `warn` hits (default true).
 * @param now - ISO timestamp.
 * @param options - `sinceMs`: only files modified at/after this epoch (incremental).
 */
export async function scanWorkspace(root, includeWarnings = true, now = new Date().toISOString(), options = {}) {
    const files = await collectFiles(root, options.sinceMs);
    const hits = [];
    let scanned = 0;
    for (const file of files) {
        const rel = relative(root, file).replace(/\\/g, '/');
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch {
            continue;
        }
        scanned += 1;
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        // STATE-NESTED-01: nested property assignment is not observed by the state
        // framework. Array APIs (push/pop/…) ARE observed on current ArkUI, so they
        // are deliberately not flagged.
        for (const match of text.matchAll(STATE_DECLARATION)) {
            const name = match[1];
            if (name === undefined)
                continue;
            const nested = new RegExp(`this\\.${name}\\.([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\s*=`, 'g');
            const arrayItem = new RegExp(`this\\.${name}\\[[^\\]]+\\]\\.([A-Za-z_$][\\w$]*)\\s*=`, 'g');
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index] ?? '';
                if (isComment(line))
                    continue;
                nested.lastIndex = 0;
                arrayItem.lastIndex = 0;
                if (nested.test(line) || arrayItem.test(line)) {
                    hits.push(hit('STATE-NESTED-01', rel, index + 1, line));
                }
            }
        }
        // Line-level rules.
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            if (isComment(line))
                continue;
            if (ANY_RULE.test(line))
                hits.push(hit('ARKTS-ANY-001', rel, index + 1, line));
            if (OHOS_MODULE.test(line))
                hits.push(hit('ARKTS-IMPORT-KIT', rel, index + 1, line));
            if (FAKE_PACKAGE.test(line))
                hits.push(hit('OHPM-FAKE-001', rel, index + 1, line));
        }
        // File-level rules.
        if (V1_DECORATORS.test(text) && V2_DECORATORS.test(text)) {
            const line = lines.findIndex((candidate) => V2_DECORATORS.test(candidate));
            hits.push(hit('ARKTS-V1V2-MIX', rel, line >= 0 ? line + 1 : 1, lines[line >= 0 ? line : 0] ?? ''));
        }
        if (LAZY_LIST.test(text) && /ForEach\s*\(/.test(text) && !/LazyForEach\s*\(/.test(text)) {
            const line = lines.findIndex((candidate) => /ForEach\s*\(/.test(candidate));
            hits.push(hit('PERF-LIST-FOREACH', rel, line >= 0 ? line + 1 : 1, lines[line >= 0 ? line : 0] ?? ''));
        }
        if (TIMER_SET.test(text) && !TIMER_CLEAR.test(text)) {
            const line = lines.findIndex((candidate) => TIMER_SET.test(candidate));
            hits.push(hit('LIFECYCLE-TIMER', rel, line >= 0 ? line + 1 : 1, lines[line >= 0 ? line : 0] ?? ''));
        }
        if (BUTTON_OR_CLICK.test(text) && !A11Y_TEXT.test(text)) {
            const line = lines.findIndex((candidate) => BUTTON_OR_CLICK.test(candidate));
            hits.push(hit('A11Y-TEXT-001', rel, line >= 0 ? line + 1 : 1, lines[line >= 0 ? line : 0] ?? ''));
        }
    }
    const visible = includeWarnings ? hits : hits.filter((entry) => entry.severity === 'must');
    return {
        schemaVersion: 1,
        scannedAt: now,
        root,
        files: scanned,
        hits: visible,
        counts: {
            must: visible.filter((entry) => entry.severity === 'must').length,
            warn: visible.filter((entry) => entry.severity === 'warn').length
        }
    };
}
/** Resolve and validate a scan path inside the workspace. */
export function resolveScanRoot(workspace, requested) {
    const root = requested === undefined ? workspace : isAbsolute(requested) ? requested : resolve(workspace, requested);
    const rel = relative(workspace, root);
    if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`扫描路径必须位于工作区内：${requested ?? ''}`);
    }
    return root;
}
