import path from 'node:path';
import { parse } from 'yaml';

export const CONTEXT_FILE_NAMES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'] as const;
export interface SkillMetadata {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}
export interface ParsedSkill {
  metadata: SkillMetadata | null;
  body: string;
  diagnostics: string[];
}
/** The locked Pi frontmatter semantics: BOM/newlines, first closing delimiter and YAML data.
 * Unknown frontmatter is not an execution policy and is deliberately absent from model metadata.
 */
export function parseSkill(content: string, filePath: string): ParsedSkill {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const end = normalized.startsWith('---') ? normalized.indexOf('\n---', 3) : -1;
  let frontmatter: unknown = {};
  let body = normalized;
  if (end !== -1) {
    const yaml = normalized.slice(4, end);
    body = normalized.slice(end + 4).trim();
    if (yaml) frontmatter = parse(yaml) ?? {};
  }
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    return { metadata: null, body, diagnostics: ['Skill frontmatter must be a mapping'] };
  }
  const data = frontmatter as Record<string, unknown>;
  const declared = path.posix.basename(filePath) === 'SKILL.md';
  const hasDescription = typeof data.description === 'string' && data.description.trim() !== '';
  if (!declared && !hasDescription) return { metadata: null, body, diagnostics: [] };
  const diagnostics: string[] = [];
  if (!hasDescription) diagnostics.push('description is required');
  else if ((data.description as string).length > 1024) diagnostics.push('description exceeds 1024 characters');
  const name = typeof data.name === 'string' && data.name ? data.name : path.posix.basename(path.posix.dirname(filePath));
  if (name.length > 64) diagnostics.push('name exceeds 64 characters');
  if (!/^[a-z0-9-]+$/.test(name)) diagnostics.push('name contains invalid characters');
  if (name.startsWith('-') || name.endsWith('-')) diagnostics.push('name must not start or end with a hyphen');
  if (name.includes('--')) diagnostics.push('name must not contain consecutive hyphens');
  return { metadata: hasDescription ? { name, description: data.description as string,
    disableModelInvocation: data['disable-model-invocation'] === true } : null, body, diagnostics };
}

export function ancestorDirectories(directory: string): string[] {
  const result = [directory];
  while (directory) {
    const parent = path.posix.dirname(directory);
    directory = parent === '.' ? '' : parent;
    result.push(directory);
  }
  return result.reverse();
}
/** Match the SDK's ignore-prefix handling, including escaped !/# and per-directory patterns. */
export function prefixIgnorePattern(line: string, prefix: string): string | null {
  if (!line.trim() || (line.trim().startsWith('#') && !line.trim().startsWith('\\#'))) return null;
  let pattern = line; let negated = false;
  if (pattern.startsWith('!')) { negated = true; pattern = pattern.slice(1); }
  else if (pattern.startsWith('\\!')) pattern = pattern.slice(1);
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  return `${negated ? '!' : ''}${prefix}${pattern}`;
}
