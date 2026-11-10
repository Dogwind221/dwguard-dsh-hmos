#!/usr/bin/env node
/** Render the human-readable design-foundations checklist from JSON. */
import { readFile, writeFile } from 'node:fs/promises';

const dir = 'docs';
const foundations = JSON.parse(await readFile(`${dir}/design-foundations.json`, 'utf8'));
const guide = JSON.parse(await readFile(`${dir}/design-guide/index.json`, 'utf8'));
const byId = new Map(guide.entries.map((entry) => [entry.id, entry]));
const lines = [
  '# 设计入门清单（0.9.4）',
  '',
  '这份清单把设计原则、布局、色彩、字体、图标、动效、无障碍翻译成**可测代理**。',
  '每一条都绑定现有 `DW-AES-*` / `DW-A11Y-*` 规则；不能指向规则和测量的“感觉”不收录。',
  '',
  `来源索引：[\`docs/design-guide/index.json\`](design-guide/index.json)（${guide.count} 篇官方设计文档的引用/摘要，不存正文）。`,
  '',
  '> 规则是验收口径；官方设计指南是方向与解释。两者冲突时，以可测规则为准，并把差异记为设计决策。',
  ''
];
for (const section of foundations.sections) {
  lines.push(`## ${section.title}`, '');
  for (const item of section.items) {
    lines.push(`### ${item.id} · ${item.title}`, '');
    lines.push(item.statement, '');
    lines.push(`- 规则：${item.ruleRefs.map((id) => `\`${id}\``).join(' / ')}`);
    lines.push(`- 可测：${item.measure}`);
    lines.push(`- 取证：${item.verify}`);
    if (item.guideRefs.length > 0) {
      const refs = item.guideRefs.map((id) => {
        const entry = byId.get(id);
        return entry === undefined ? `\`${id}\`` : `[${entry.leaf}](${entry.url})`;
      });
      lines.push(`- 官方原文：${refs.join(' / ')}`);
    }
    lines.push('');
  }
}
await writeFile(`${dir}/design-foundations.md`, `${lines.join('\n')}\n`, 'utf8');
console.log(`wrote ${dir}/design-foundations.md (${foundations.sections.length} sections)`);
