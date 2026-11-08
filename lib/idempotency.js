/**
 * Command-id idempotency (0.8.5).
 *
 * Every tool accepts an optional `commandId`. Re-submitting the same id in the
 * same workspace returns the first result instead of repeating bookkeeping
 * (audits, dispatches, confirmations…). The ledger is protected by a lock file.
 *
 * @module dwguard-dsh-hmos/idempotency
 */
import { withFileLock } from './lockfile.js';
import { asRecord, optionalString } from './tools/args.js';
import { pathsOf } from './tools/common.js';
import { ensureDir, readTextOrNull, writeTextAtomic } from './util/fs.js';
import { nowIso } from './util/md.js';
function emptyLedger() {
    return { schemaVersion: 1, commands: {} };
}
async function runOnce(paths, commandId, tool, run) {
    await ensureDir(paths.artifactsDir);
    const ledgerFile = `${paths.artifactsDir}/.command-ledger.json`;
    return withFileLock(`${ledgerFile}.lock`, async () => {
        const raw = await readTextOrNull(ledgerFile);
        let ledger = emptyLedger();
        if (raw !== null) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed.schemaVersion === 1 && typeof parsed.commands === 'object' && parsed.commands !== null) {
                    ledger = { schemaVersion: 1, commands: parsed.commands };
                }
            }
            catch {
                /* corrupt ledger is treated as empty; the command can be retried */
            }
        }
        const existing = ledger.commands[commandId];
        if (existing !== undefined) {
            if (existing.tool !== tool) {
                throw new Error(`commandId \`${commandId}\` 已被 \`${existing.tool}\` 使用，不能复用于 \`${tool}\`。`);
            }
            return existing.result;
        }
        const result = await run();
        const next = {
            schemaVersion: 1,
            commands: {
                ...ledger.commands,
                [commandId]: { tool, at: nowIso(), result }
            }
        };
        // Bound the ledger so a long-lived workspace does not grow forever.
        const ids = Object.keys(next.commands);
        const bounded = ids.length <= 200
            ? next
            : {
                schemaVersion: 1,
                commands: Object.fromEntries(ids.slice(-200).map((id) => [id, next.commands[id]]))
            };
        await writeTextAtomic(ledgerFile, `${JSON.stringify(bounded, null, 2)}\n`);
        return result;
    });
}
/** Add `commandId` to a tool and make repeated calls idempotent. */
export function withCommandIdempotency(tool, options, ctx) {
    return {
        ...tool,
        parameters: {
            ...tool.parameters,
            commandId: {
                type: 'string',
                description: '幂等 ID（可选）：同一 workspace 内重复提交同一 commandId 会返回首次结果，不重复记账。'
            }
        },
        async execute(rawArgs, exec) {
            const args = asRecord(rawArgs, tool.name);
            const commandId = optionalString(args, 'commandId', tool.name, 80);
            if (commandId === undefined)
                return tool.execute(rawArgs, exec);
            const paths = await pathsOf(exec, { options, ctx }, tool.name);
            return (await runOnce(paths, commandId, tool.name, () => tool.execute(rawArgs, exec)));
        }
    };
}
export { withCommandIdempotency as withCommandId };
