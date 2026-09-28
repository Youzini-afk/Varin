import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const marker = '<!-- varin-dependency-report -->';

// Dependabot's body is data, never code. Keep excerpts as escaped text and avoid
// mentioning upstream authors again when publishing the digest.
const text = (value) => String(value).replace(/<[^>]*>/g, '')
  .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (entity) => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  })[entity]).replace(/[\u200b\u200c]/g, '').trim();
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/\|/g, '&#124;').replace(/@/g, '@\u200b');
const code = (value) => `<code>${escape(value)}</code>`;

function upgradeKind(from, to) {
  const previous = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(from);
  const next = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(to);
  if (!previous || !next) return '版本／提交变更';
  if (previous[1] !== next[1]) return '跨大版本';
  if (previous[2] !== next[2]) return previous[1] === '0' ? '0.x 次版本（可能不兼容）' : '次版本';
  return '补丁';
}

export function parseUpdates(body) {
  const updates = new Map();
  const add = (name, from, to, section = '') => {
    name = text(name).replace(/^`|`$/g, '');
    const existing = updates.get(name);
    updates.set(name, { name, from, to, section: section || existing?.section || '' });
  };
  // Large grouped PRs keep the complete version table even when their notes hit
  // GitHub's description limit. Do not silently lose the dependencies at the end.
  for (const match of body.matchAll(/^\|\s*(?:\[([^\]]+)\]\([^\n]+?\)|([^|]+?))\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm)) {
    add(match[1] || match[2], match[3], match[4]);
  }
  const sections = [...body.matchAll(/^Updates `([^`]+)` from (\S+) to (\S+)\s*$/gm)];
  for (let i = 0; i < sections.length; i++) {
    const match = sections[i];
    add(match[1], match[2], match[3], body.slice(match.index, sections[i + 1]?.index ?? body.length));
  }
  if (updates.size === 0) {
    const match = /^Bumps (?:\[([^\]]+)\]\([^\n]+?\)|`([^`]+)`|(\S+)) from (\S+) to (\S+?)(?:\.|\r)?$/m.exec(body);
    if (match) add(match[1] || match[2] || match[3], match[4], match[5], body);
  }
  return [...updates.values()];
}

function material(section) {
  const sources = [...section.matchAll(/Sourced from <a href="(https:\/\/[^"\s]+)"/g),
    ...section.matchAll(/href="(https:\/\/[^"\s]+\/(?:compare|commits)\/[^"\s]+)"/g)].map((match) => match[1]);
  const notes = [];
  for (const match of section.matchAll(/<details>\s*<summary>(Release notes|Changelog)<\/summary>([\s\S]*?)<\/details>/g)) {
    const quote = /<blockquote>([\s\S]*?)<\/blockquote>/.exec(match[2]);
    if (!quote) continue;
    const content = text(quote[1].replace(/<(?:h[1-6]|li|p|pre|br)\b[^>]*>/g, '\n')
      .replace(/<\/(?:h[1-6]|li|p|pre)>/g, '\n')).replace(/\n\s*\n/g, '\n\n');
    const breaking = /<h([1-6])[^>]*>[^<]*(?:breaking changes?|migration|incompatible)[\s\S]*?<\/h\1>([\s\S]*?)(?=<h[1-6]\b|$)/i.exec(quote[1]);
    const items = [...(breaking?.[2] || quote[1]).matchAll(/<li>([\s\S]*?)<\/li>/g)]
      .map((item) => text(item[1]).replace(/\s+/g, ' '));
    notes.push({ kind: match[1], content, preview: (breaking ? '破坏性变更原文摘录：\n' : '')
      + (items.length ? items.slice(0, 4).map((item) => `• ${item}`).join('\n') : content.split('\n').filter(Boolean).slice(0, 7).join('\n')) });
  }
  return { sources: [...new Set(sources)], notes,
    incomplete: /truncated|raw HTML omitted/i.test(section) };
}

export function renderReport(pr, files, runUrl) {
  const updates = parseUpdates(pr.body || '');
  // Rebases and reruns change SHAs/artifact URLs without changing the material
  // being reviewed. Only changed dependency evidence warrants editing a comment.
  const fingerprint = createHash('sha256').update(JSON.stringify({
    updates: updates.map(({ name, from, to, section }) => ({ name, from, to, evidence: material(section) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    files: files.map((file) => file.filename).sort(),
    truncated: /Description has been truncated/i.test(pr.body || ''),
    unparsed: updates.length ? undefined : pr.body,
  })).digest('hex');
  const contentMarker = `<!-- varin-dependency-content:${fingerprint} -->`;
  const groups = new Map();
  const rows = [];
  for (const update of updates) {
    const evidence = material(update.section);
    const warnings = [];
    if (evidence.incomplete) warnings.push('上游摘录有省略');
    if (!evidence.notes.length) warnings.push('PR 中没有可提取的发布说明');
    if (evidence.notes.some((note) => /breaking changes?|migration|incompatible|removed\b/i.test(note.content))) {
      warnings.push('原文包含破坏性变更／迁移／移除提示');
    }
    rows.push(`| ${code(update.name)} | ${code(update.from)} → ${code(update.to)} | ${upgradeKind(update.from, update.to)} | ${warnings.join('；') || '有上游变更材料'} |`);
    for (const note of evidence.notes) {
      const key = createHash('sha256').update(note.content).digest('hex');
      const group = groups.get(key) || { ...note, packages: [], sources: new Set() };
      group.packages.push(`${update.name} ${update.from} → ${update.to}`);
      evidence.sources.forEach((source) => group.sources.add(source));
      groups.set(key, group);
    }
  }
  const intro = [marker, contentMarker, '## 依赖更新速览', '',
    `材料采集时 [PR #${pr.number}](${pr.html_url}) 的提交为 ${code(pr.head.sha.slice(0, 12))}。`, '',
    '按 Dependabot 提供的当前版本→目标版本材料整理，相同上游说明合并展示。原文摘录保留原语言；这份自动材料不代表已完成 Varin 兼容性审查。', '',
    '| 依赖 | 当前 → 目标 | 版本变化 | 材料提示 |', '| --- | --- | --- | --- |', ...rows, '',
    ...(updates.length ? [] : ['未识别出版本区间，请查看原 PR；没有把缺少材料解释为“无变化”。', '']),
    ...(/Description has been truncated/i.test(pr.body || '') ? ['**Dependabot 的 PR 正文已被截断，缺失部分需沿上游链接补查。**', ''] : []),
    '变更文件：', '', ...files.map((file) => `- ${code(file.filename)}`), '',
    '版本号只描述发布编号；补丁、次版本同样可能改变行为。合并前需结合实际调用处判断收益、迁移要求和必要验证。', '',
  ].join('\n');
  const sourceLinks = (group) => [...group.sources].map((url, i) => `[上游来源 ${i + 1}](${url.replace(/[()]/g, (c) => c === '(' ? '%28' : '%29')})`).join(' · ');
  const details = [...groups.values()].map((group) => [
    `### ${group.packages.map(code).join(' / ')}`, '', sourceLinks(group), '',
    `<pre>${escape(group.content)}</pre>`, '',
  ].join('\n'));
  const previews = [...groups.values()].map((group) => {
    // This is a display excerpt, not a claim that other changes are unimportant.
    return `<details>\n<summary>${group.packages.map(escape).join(' / ')} — 原文摘录</summary>\n\n${sourceLinks(group)}\n\n<pre>${escape(group.preview)}</pre>\n\n</details>\n`;
  });
  const footer = `\n[整理后的全部材料与原始数据](${runUrl})（运行页面的 dependency-report 附件）。完整版本区间是否齐全仍以所列上游发布记录为准。\n`;
  let comment = intro;
  for (const preview of previews) {
    // GitHub issue comments have a 65,536-character body limit. The artifact
    // retains everything; only the in-comment preview is shortened.
    if (comment.length + preview.length + footer.length > 64_000) {
      comment += '\n其余摘录见附件。\n';
      break;
    }
    comment += preview;
  }
  if (comment.length > 64_000) comment = `${marker}\n${contentMarker}\n## 依赖更新速览\n\n更新清单超过评论展示长度，全部材料已保存到附件。\n`;
  return { comment: comment + footer, markdown: intro + details.join('\n'), updates, contentMarker };
}

export function shouldPublishReport(existingBody, report) {
  return !existingBody?.includes(report.contentMarker);
}

function api(path, { method, data } = {}) {
  const args = ['api', path];
  if (method) args.push('--method', method);
  if (data) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, {
    encoding: 'utf8', input: data ? JSON.stringify(data) : undefined,
    maxBuffer: 16 * 1024 * 1024,
  }));
}

function paginate(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const next = api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    items.push(...next);
    if (next.length < 100) return items;
  }
}

export function run({ repo, number, output, publish = false }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(String(number))) throw new Error('Expected owner/repo and a PR number');
  const base = `repos/${repo}`;
  if (publish && !existsSync(resolve(output, 'source.json'))) {
    console.log('No report to publish (the PR may already be closed).');
    return;
  }
  // Publish the exact snapshot already uploaded as the artifact, rather than
  // recollecting a newer PR and linking a comment to older evidence.
  const saved = publish ? JSON.parse(readFileSync(resolve(output, 'source.json'), 'utf8')) : undefined;
  const pr = saved?.pr || api(`${base}/pulls/${number}`);
  if (pr.number !== Number(number) || pr.base.repo.full_name !== repo) throw new Error('Report snapshot belongs to a different pull request');
  if (pr.user.login !== 'dependabot[bot]') throw new Error('This report only processes Dependabot pull requests');
  if (pr.state !== 'open') return;
  const files = saved?.files || paginate(`${base}/pulls/${number}/files`);
  const runUrl = process.env.GITHUB_RUN_ID
    ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : pr.html_url;
  const report = renderReport(pr, files, runUrl);
  if (!publish) {
    mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, 'report.md'), report.markdown);
    writeFileSync(resolve(output, 'comment.md'), report.comment);
    writeFileSync(resolve(output, 'source.json'), JSON.stringify({ pr, files }, null, 2));
    return report;
  }
  const current = api(`${base}/pulls/${number}`);
  if (current.state !== 'open' || current.head.sha !== pr.head.sha || current.body !== pr.body) {
    console.log('PR changed during reporting; a subsequent event will refresh the report.');
    return report;
  }
  const existing = paginate(`${base}/issues/${number}/comments`)
    .find((comment) => comment.user.login === 'github-actions[bot]' && comment.body.startsWith(marker));
  if (shouldPublishReport(existing?.body, report)) {
    api(existing ? `${base}/issues/comments/${existing.id}` : `${base}/issues/${number}/comments`, {
      method: existing ? 'PATCH' : 'POST', data: { body: report.comment },
    });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  run({ repo: process.env.GITHUB_REPOSITORY, number: process.env.PR_NUMBER || event.pull_request?.number,
    output: process.env.REPORT_DIR || 'artifacts/dependency-report', publish: process.argv.includes('--publish') });
}
