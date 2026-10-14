/** Explicit Host/project MCP sources. A project connection replaces a complete user connection. */
import { open } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { object } from '../models/configuration.js';
export type McpExposure = 'direct' | 'codemode' | 'deferred' | 'hidden';
interface McpConfigBase { enabled?: boolean; exposure?: McpExposure; toolExposure?: Record<string, McpExposure>; description?: string; timeout?: number }
export interface McpStdioServerConfig extends McpConfigBase { command: string; args?: string[]; env?: Record<string, string>; cwd?: string; type?: 'stdio' }
export interface McpHttpServerConfig extends McpConfigBase { url: string; type?: 'http'; headers?: Record<string, string>; auth?: { provider: string }; oauth?: { clientId?: string; clientSecret?: string; callbackPort?: number; callbackUrl?: string; scope?: string } }
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
export interface McpServerEntry { name: string; config: McpServerConfig; source: string; scope?: 'global' | 'project' | 'extension'; override?: string; sourceVersion?: string }
export interface LoadedMcpConfig { servers: McpServerEntry[]; errors: string[]; sources: string[]; autoEnableCodemode?: boolean; projectConfig?: string }
interface Source { servers: McpServerEntry[]; policies: Record<string, unknown>; sources: string[]; autoEnableCodemode?: boolean }
export interface McpConfigurationScope { agentDir: string; cwd: string; projectTrusted: boolean }
const strings = (value: unknown) => object(value) && Object.values(value).every(value => typeof value === 'string');
export function validateMcpPolicy(input: unknown): string | undefined {
  if (!object(input) || Object.keys(input).some(key => !['enabled', 'exposure', 'toolExposure'].includes(key))
    || input.enabled !== undefined && typeof input.enabled !== 'boolean'
    || input.exposure !== undefined && !['direct', 'codemode', 'deferred', 'hidden'].includes(String(input.exposure))
    || input.toolExposure !== undefined && (!object(input.toolExposure) || Object.values(input.toolExposure).some(value => !['direct', 'codemode', 'deferred', 'hidden'].includes(String(value))))) return 'Server policy is invalid';
}
export function validateMcpDocument(input: unknown): string | undefined {
  if (!object(input) || input.mcpServers !== undefined && !object(input.mcpServers)
    || input.mcpPolicies !== undefined && !object(input.mcpPolicies)
    || input.sources !== undefined && (!Array.isArray(input.sources) || input.sources.some(source => typeof source !== 'string'))
    || input.autoEnableCodemode !== undefined && typeof input.autoEnableCodemode !== 'boolean') return 'MCP configuration must contain valid servers, sources and policies';
}
export function validateMcpServerConfig(name: string, input: unknown): McpServerConfig | string {
  if (!name || !object(input)) return 'Server configuration must be an object';
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean' || input.exposure !== undefined && !['direct', 'codemode', 'deferred', 'hidden'].includes(String(input.exposure))
    || input.timeout !== undefined && (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0)
    || input.toolExposure !== undefined && (!object(input.toolExposure) || Object.values(input.toolExposure).some(value => !['direct', 'codemode', 'deferred', 'hidden'].includes(String(value))))) return 'Server policy is invalid';
  if (typeof input.command === 'string' && input.command.trim() && input.url === undefined) {
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string')) || input.env !== undefined && !strings(input.env) || input.cwd !== undefined && typeof input.cwd !== 'string') return 'Server command arguments, environment or cwd are invalid';
    return structuredClone(input) as unknown as McpStdioServerConfig;
  }
  if (typeof input.url === 'string' && input.command === undefined) {
    try { const url = new URL(input.url); if (!['http:', 'https:'].includes(url.protocol)) return 'Server URL must use HTTP'; } catch { return 'Server URL is invalid'; }
    if (input.headers !== undefined && !strings(input.headers) || input.auth !== undefined && (!object(input.auth) || typeof input.auth.provider !== 'string') || input.oauth !== undefined && !object(input.oauth)) return 'Server authentication is invalid';
    return structuredClone(input) as unknown as McpHttpServerConfig;
  }
  return 'Define one command or URL for this server';
}
async function readSource(accepted: Map<string, Source>, path: string, scope: 'global' | 'project', errors: string[]): Promise<Source | undefined> {
  const key = JSON.stringify([scope, path]);
  let document: unknown;
  let version: string;
  try {
    const parseErrors: ParseError[] = [];
    // Read bytes and metadata from the same opened file, including across atomic replacement.
    const file = await open(path, 'r');
    try {
      const text = await file.readFile('utf8'), stat = await file.stat({ bigint: true });
      version = JSON.stringify([String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
      document = parse(text.replace(/^\uFEFF/, ''), parseErrors, { allowTrailingComma: true });
    } finally { await file.close(); }
    if (parseErrors.length || validateMcpDocument(document)) throw new Error('Invalid MCP configuration');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { accepted.delete(key); return undefined; }
    errors.push(`MCP configuration could not be read: ${path}`);
    const previous = accepted.get(key);
    return previous ? structuredClone(previous) : undefined;
  }
  if (!object(document)) throw new Error('Invalid MCP configuration');
  const servers: McpServerEntry[] = [];
  for (const [name, raw] of Object.entries(document.mcpServers ?? {})) {
    const config = validateMcpServerConfig(name, raw);
    if (typeof config === 'string' || scope === 'project' && 'url' in config && config.auth) {
      errors.push(`${name}: ${typeof config === 'string' ? config : 'Project configuration cannot select a user model account'}`);
      const previous = accepted.get(key)?.servers.find(entry => entry.name === name);
      if (previous) servers.push(previous);
    } else {
      const previous = accepted.get(key)?.servers.find(entry => entry.name === name);
      servers.push({ name, config, source: path, scope,
        sourceVersion: previous && isDeepStrictEqual(previous.config, config) ? previous.sourceVersion ?? version : version });
    }
  }
  const policies: Record<string, unknown> = {};
  for (const [name, policy] of Object.entries(document.mcpPolicies ?? {})) {
    const issue = validateMcpPolicy(policy);
    if (issue) { errors.push(`${name}: ${issue}`); if (Object.hasOwn(accepted.get(key)?.policies ?? {}, name)) policies[name] = accepted.get(key)!.policies[name]; }
    else policies[name] = policy;
  }
  const source: Source = { servers, policies,
    sources: scope === 'global' && Array.isArray(document.sources) ? document.sources.filter((value): value is string => typeof value === 'string') : [],
    ...(typeof document.autoEnableCodemode === 'boolean' ? { autoEnableCodemode: document.autoEnableCodemode } : {}) };
  accepted.set(key, structuredClone(source));
  return source;
}
async function readConfiguration(accepted: Map<string, Source>, options: McpConfigurationScope): Promise<LoadedMcpConfig> {
  const errors: string[] = [];
  const globalPath = join(options.agentDir, 'mcp.json');
  const global = await readSource(accepted, globalPath, 'global', errors);
  const sources = [...new Set([globalPath, ...(global?.sources ?? []).map(path => resolve(options.agentDir, path))])];
  const entries = new Map<string, McpServerEntry>();
  const external = await Promise.all(sources.filter(path => path !== globalPath).map(path => readSource(accepted, path, 'global', errors)));
  for (const source of external) for (const entry of source?.servers ?? []) entries.set(entry.name, entry);
  for (const entry of global?.servers ?? []) entries.set(entry.name, entry);
  const projectPath = options.projectTrusted ? join(options.cwd, '.mcp.json') : undefined;
  if (projectPath) sources.push(projectPath);
  const project = projectPath ? await readSource(accepted, projectPath, 'project', errors) : undefined;
  for (const entry of project?.servers ?? []) entries.set(entry.name, entry);
  for (const source of [global, project]) for (const [name, policy] of Object.entries(source?.policies ?? {})) {
    const entry = entries.get(name);
    if (!entry) continue;
    if (!object(policy) || validateMcpPolicy(policy)) { errors.push(`${name}: Server policy is invalid`); continue; }
    const config = validateMcpServerConfig(name, { ...entry.config, ...policy });
    if (typeof config === 'string') errors.push(`${name}: ${config}`);
    else entries.set(name, { ...entry, config, ...(source === project ? { override: projectPath! } : {}) });
  }
  return { servers: [...entries.values()], errors: errors.sort(), sources, autoEnableCodemode: project?.autoEnableCodemode ?? global?.autoEnableCodemode ?? true,
    ...(projectPath ? { projectConfig: projectPath } : {}) };
}
/** Configuration preparation publishes a whole scope. Execution checks never read the disk. */
export class McpConfigurations {
  readonly #scopes = new Map<string, { accepted: Map<string, Source>; current?: LoadedMcpConfig; pending?: Promise<LoadedMcpConfig> | undefined; requested: number }>();
  #state(options: McpConfigurationScope) {
    const key = JSON.stringify([resolve(options.agentDir), resolve(options.cwd), options.projectTrusted]);
    let state = this.#scopes.get(key);
    if (!state) { state = { accepted: new Map(), requested: 0 }; this.#scopes.set(key, state); }
    return state;
  }
  current(options: McpConfigurationScope): LoadedMcpConfig {
    const current = this.#state(options).current;
    if (!current) throw new Error('MCP configuration has not been prepared');
    return current;
  }
  prepare(options: McpConfigurationScope, reload = false): Promise<LoadedMcpConfig> {
    const state = this.#state(options);
    if (!reload && state.current && !state.pending) return Promise.resolve(state.current);
    if (reload) state.requested++;
    if (!state.pending) {
      const work = (async () => {
        for (;;) {
          const requested = state.requested;
          const current = await readConfiguration(state.accepted, options);
          if (state.requested !== requested) continue;
          state.current = current; return current;
        }
      })();
      state.pending = work;
      void work.then(() => { if (state.pending === work) state.pending = undefined; }, () => { if (state.pending === work) state.pending = undefined; });
    }
    return state.pending;
  }
}
export function getMcpToolExposure(config: McpServerConfig, tool: string): McpExposure {
  if (Object.hasOwn(config.toolExposure ?? {}, tool)) return config.toolExposure![tool]!;
  for (const [pattern, exposure] of Object.entries(config.toolExposure ?? {})) {
    const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    if (new RegExp(`^${escaped}$`).test(tool)) return exposure;
  }
  return config.exposure ?? 'codemode';
}
const namePart = (value: string) => [...value].map(char => /^[a-zA-Z0-9]$/.test(char) ? char : `_x${char.codePointAt(0)!.toString(16)}_`).join('');
export const createMcpToolName = (server: string, tool: string) => `mcp__${namePart(server)}__${namePart(tool)}`;
