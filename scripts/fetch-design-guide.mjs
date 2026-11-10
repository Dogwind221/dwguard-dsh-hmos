#!/usr/bin/env node
/**
 * Refresh the Huawei UX design-guide index.
 *
 * The source is the Markdown index published by Huawei:
 *   https://developer.huawei.com/consumer/cn/llms/docs-ux-design.txt
 *
 * We fetch each linked Markdown document to compute its sha256/fetch date and
 * derive a short summary, but we DO NOT store the document body, images or
 * downloadable design assets. The output is a citation/summary index only.
 *
 * Usage:
 *   node scripts/fetch-design-guide.mjs --out docs/design-guide/index.json
 *   node scripts/fetch-design-guide.mjs --limit 12 --concurrency 3
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const INDEX_URL = 'https://developer.huawei.com/consumer/cn/llms/docs-ux-design.txt';
const DEFAULT_OUT = 'docs/design-guide/index.json';
const FETCH_TIMEOUT_MS = 30_000;
const RETRIES = 2;

function args(argv) {
  const out = { out: DEFAULT_OUT, concurrency: 4, limit: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--out') { out.out = argv[index + 1]; index += 1; }
    else if (key === '--concurrency') { out.concurrency = Number(argv[index + 1]); index += 1; }
    else if (key === '--limit') { out.limit = Number(argv[index + 1]); index += 1; }
    else if (key === '--dry-run') out.dryRun = true;
    else if (key === '--help' || key === '-h') out.help = true;
  }
  return out;
}

const OUTLINE = [
  ['动效', ['DW-AES-11']],
  ['动画', ['DW-AES-11']],
  ['转场', ['DW-AES-11']],
  ['字体', ['DW-AES-02']],
  ['字号', ['DW-AES-02']],
  ['排版', ['DW-AES-02']],
  ['色彩', ['DW-AES-04']],
  ['颜色', ['DW-AES-04']],
  ['色', ['DW-AES-04']],
  ['间距', ['DW-AES-01', 'DW-AES-05']],
  ['栅格', ['DW-AES-01']],
  ['留白', ['DW-AES-05']],
  ['布局', ['DW-AES-01', 'DW-AES-05']],
  ['圆角', ['DW-AES-03']],
  ['阴影', ['DW-AES-03']],
  ['图标', ['DW-AES-10', 'DW-AES-20']],
  ['Symbol', ['DW-AES-20']],
  ['按钮', ['DW-AES-12']],
  ['列表', ['DW-AES-13', 'DW-AES-21']],
  ['输入', ['DW-AES-14']],
  ['文本', ['DW-AES-14']],
  ['弹窗', ['DW-AES-15']],
  ['弹出', ['DW-AES-15']],
  ['半模态', ['DW-AES-15']],
  ['标题栏', ['DW-AES-16']],
  ['页签', ['DW-AES-17']],
  ['开关', ['DW-AES-18']],
  ['进度', ['DW-AES-19']],
  ['卡片', ['DW-AES-21']],
  ['多设备', ['DW-AES-07']],
  ['折叠', ['DW-AES-07']],
  ['深色', ['DW-AES-08']],
  ['暗色', ['DW-AES-08']],
  ['无障碍', ['DW-A11Y-01', 'DW-A11Y-02', 'DW-A11Y-04']],
  ['对比度', ['DW-A11Y-01']],
  ['热区', ['DW-A11Y-02']],
  ['焦点', ['DW-A11Y-03', 'DW-A11Y-12']],
  ['键盘', ['DW-A11Y-12']],
  ['可访问', ['DW-A11Y-04']],
  ['宽屏', ['DW-AES-07']],
  ['自适应', ['DW-AES-07']],
  ['分栏', ['DW-AES-07']],
  ['宫格', ['DW-AES-07']],
  ['响应式', ['DW-AES-07']],
  ['折叠屏', ['DW-AES-07']],
  ['图文', ['DW-AES-06']],
  ['图片', ['DW-AES-06']],
  ['列表', ['DW-AES-13']],
  ['卡片', ['DW-AES-21']],
  ['弹窗', ['DW-AES-15']],
  ['悬停', ['DW-AES-11']],
  ['视频', ['DW-AES-11']],
  ['直播', ['DW-AES-11']],
  ['推荐', ['DW-AES-21']],
  ['实况', ['DW-AES-21']],
  ['海报', ['DW-AES-06']],
  ['主页', ['DW-AES-05']],
  ['布局', ['DW-AES-05']]
];

function ruleRefs(title) {
  const refs = new Set();
  for (const [keyword, ids] of OUTLINE) {
    if (title.toLowerCase().includes(keyword.toLowerCase())) for (const id of ids) refs.add(id);
  }
  return [...refs];
}

function sectionAnchor(url, title) {
  const page = url.replace(/\.md$/, '');
  return {
    anchor: `#${encodeURIComponent(title)}`,
    anchorUrl: `${page}#${encodeURIComponent(title)}`,
    anchorKind: 'heading-fragment'
  };
}

/**
 * Build per-heading sections without storing their bodies.
 * H1 is the document root; sections are H2/H3/... entries.
 */
function buildSections(markdown, entry) {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  const sections = [];
  let rootTitle = entry.leaf;
  let stack = [];
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index];
    const level = match[1].length;
    const title = match[2].trim();
    if (level === 1) {
      rootTitle = title;
      stack = [{ level, title }];
      continue;
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < headings.length ? (headings[index + 1].index ?? markdown.length) : markdown.length;
    const body = markdown.slice(start, end);
    const digest = summarize(body);
    const path = stack.map((item) => item.title);
    const directRules = ruleRefs(`${entry.title} ${path.join(' ')} ${digest.summary}`);
    const anchor = sectionAnchor(entry.url, title);
    sections.push({
      id: `${entry.id}-S${String(sections.length + 1).padStart(2, '0')}`,
      hwUxId: entry.id,
      level,
      title,
      headingPath: path,
      summary: digest.summary || `${title}（${rootTitle}，官方原文见链接）`,
      ruleRefs: directRules,
      mappingStatus: directRules.length > 0 ? 'direct' : 'unbound',
      anchor: anchor.anchor,
      anchorUrl: anchor.anchorUrl,
      anchorKind: anchor.anchorKind,
      contentStored: false
    });
  }
  // A parent section without its own prose inherits the union of its child
  // sections' rules. Do not invent a rule for leaves with no match.
  for (const parent of sections) {
    if (parent.ruleRefs.length > 0) continue;
    const prefix = parent.headingPath.join('\u0000');
    const inherited = new Set();
    for (const child of sections) {
      if (child === parent) continue;
      if (child.headingPath.length <= parent.headingPath.length) continue;
      if (child.headingPath.slice(0, parent.headingPath.length).join('\u0000') !== prefix) continue;
      for (const rule of child.ruleRefs) inherited.add(rule);
    }
    if (inherited.size > 0) {
      parent.ruleRefs = [...inherited];
      parent.mappingStatus = 'descendant';
    }
  }
  return sections;
}

function sectionOf(title) {
  const parts = title.split('-');
  return parts.length > 2 ? parts.slice(2, -1).join(' / ') : parts.slice(1).join(' / ');
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*|__|[*`]/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarize(markdown) {
  const headings = [...markdown.matchAll(/^(#{1,4})\s+(.+)$/gm)].map((match) => match[2].trim()).slice(0, 8);
  const paragraphs = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n{2,}/)
    .map((item) => stripMarkdown(item))
    .filter((item) => item.length >= 20 && !/^https?:\/\//i.test(item));
  // Prefer a real sentence over a bold outline made only of labels.
  const sentence = paragraphs.find((item) => /[。！？.!?]/.test(item) && item.length >= 40);
  const prose = paragraphs.find((item) => /[，,、；;]/.test(item) && item.length >= 30);
  const excerpt = sentence ?? prose ?? '';
  return {
    summary: excerpt.slice(0, 260),
    outline: headings
  };
}

async function fetchText(url) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'dwguard-design-guide/0.9.4', accept: 'text/markdown,text/plain,*/*' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

function parseIndex(text) {
  return text
    .split('\n')
    .map((line) => /^- \[([^\]]+)\]\((https?:\/\/[^)]+\.md)\)(?::(.+))?$/.exec(line.trim()))
    .filter(Boolean)
    .map((match, index) => ({
      id: `HW-UX-${String(index + 1).padStart(3, '0')}`,
      title: match[1].trim(),
      url: match[2].trim(),
      leaf: (match[3] ?? '').trim() || match[1].trim()
    }));
}

async function run() {
  const options = args(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/fetch-design-guide.mjs [--out FILE] [--limit N] [--concurrency N] [--dry-run]');
    return;
  }
  const indexText = await fetchText(INDEX_URL);
  const all = parseIndex(indexText);
  const entries = options.limit === null ? all : all.slice(0, options.limit);
  if (options.dryRun) {
    console.log(`${all.length} entries; would fetch ${entries.length}`);
    return;
  }
  const result = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor];
      cursor += 1;
      try {
        const body = await fetchText(entry.url);
        const hash = createHash('sha256').update(body, 'utf8').digest('hex');
        const digest = summarize(body);
        const section = sectionOf(entry.title);
        result.push({
          ...entry,
          section,
          summary: digest.summary || `${entry.leaf}（${section || '设计文档'}，官方原文见链接）`,
          outline: digest.outline,
          sections: buildSections(body, entry),
          ruleRefs: ruleRefs(entry.title),
          ruleRefs: ruleRefs(entry.title),
          sha256: hash,
          bytes: Buffer.byteLength(body, 'utf8'),
          fetchedAt: new Date().toISOString(),
          contentStored: false
        });
        console.log(`ok ${entry.id} ${entry.title}`);
      } catch (error) {
        result.push({
          ...entry,
          section: sectionOf(entry.title),
          summary: '',
          outline: [],
          sections: [],
          ruleRefs: ruleRefs(entry.title),
          sha256: null,
          bytes: null,
          fetchedAt: new Date().toISOString(),
          contentStored: false,
          error: error instanceof Error ? error.message : String(error)
        });
        console.error(`fail ${entry.id} ${entry.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, entries.length)) }, worker));
  result.sort((left, right) => left.id.localeCompare(right.id));
  const output = {
    schemaVersion: 1,
    source: INDEX_URL,
    sourceSha256: createHash('sha256').update(indexText, 'utf8').digest('hex'),
    sourceUpdateTime: (indexText.match(/update_time:\s*(\S+)/) ?? [])[1] ?? null,
    fetchedAt: new Date().toISOString(),
    license: 'Huawei official documentation terms; citation/summary only; no redistribution',
    count: result.length,
    sectionCount: result.reduce((total, entry) => total + (entry.sections?.length ?? 0), 0),
    stored: 'citation-and-summary-only; no document body, images or asset files',
    entries: result
  };
  const target = resolve(options.out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`wrote ${target} (${result.length} entries, ${result.filter((entry) => entry.sha256 === null).length} failures)`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
