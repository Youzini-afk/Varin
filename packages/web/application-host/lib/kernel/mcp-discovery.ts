/** Read-only discovery over the retained MCP owner; no connection, authorization or execution owner. */
import { createHash } from 'node:crypto';
import type { McpAuthorityTool, McpCachedTool, McpAuthorityService, McpAuthorityServerReadiness } from '../mcp/authority.js';
type Json = Record<string, unknown>;
export class McpDiscoveryError extends Error {
    constructor(readonly code: string) { super(code); }
}
export interface McpDiscoveryQuery {
    server?: string;
    tool?: string;
    query?: string;
    detail?: 'summary' | 'full';
    path?: string;
}
interface Cursor {
    directory: string;
    selection: McpDiscoveryQuery;
    offset: number;
}
const object = (value: unknown): value is Json => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const terms = [['截图', '截屏', '屏幕', 'screenshot', 'screen', 'capture'], ['文件', 'file', 'directory'], ['读取', '查看', 'read', 'observe'], ['浏览器', '网页', 'browser', 'page'], ['办公', '文档', '表格', 'office', 'document', 'worksheet'], ['搜索', '检索', 'search', 'find'],
    ['科研','论文','文献','research','scholarly','paper'],['编辑','修改','写入','edit','write','replace'],['桌面','应用','desktop','application'],['设置','配置','settings','configuration'],['图片','图像','image']];
function score(query: string, text: string): number {
    query = normalize(query);
    const words = new Set(normalize(query).split(/\s+/));
    for (const family of terms)
        if (family.some(word => query.includes(word)))
            for (const word of family)
                words.add(word);
    const normalized = normalize(text);
    return [...words].reduce((sum, word) => sum + (word && normalized.includes(word) ? 1 : 0), 0);
}
function schemaTerms(value: unknown): string {
    if (Array.isArray(value))
        return value.map(schemaTerms).join(' ');
    if (!object(value))
        return '';
    return Object.entries(value).map(([key, value]) => (['properties', '$defs', 'definitions'].includes(key) && object(value) ? Object.keys(value).join(' ') :
        ['const', 'enum', 'description', 'title'].includes(key) ? JSON.stringify(value) : '') + ' ' + schemaTerms(value)).join(' ');
}
function decode(cursor: string): Cursor {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
    catch { throw new McpDiscoveryError('mcp_discovery_cursor_invalid'); }
    if (!object(value) || typeof value.directory !== 'string' || !object(value.selection) || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0
        || Object.keys(value.selection).some(key => !['server', 'tool', 'query', 'detail', 'path'].includes(key))
        || Object.values(value.selection).some(item => typeof item !== 'string'))
        throw new McpDiscoveryError('mcp_discovery_cursor_invalid');
    return value as unknown as Cursor;
}
export function mcpDiscoverySelection(args: Json): McpDiscoveryQuery {
    if (typeof args.cursor === 'string') {
        if (Object.keys(args).length !== 1)
            throw new McpDiscoveryError('mcp_discovery_cursor_must_be_used_alone');
        return decode(args.cursor).selection;
    }
    if (args.path !== undefined && args.tool === undefined)
        throw new McpDiscoveryError('mcp_discovery_path_requires_tool');
    return args as McpDiscoveryQuery;
}
function next(directory: string, selection: McpDiscoveryQuery, offset: number) {
    return { tool: 'mcp_discover', arguments: { cursor: Buffer.from(JSON.stringify({ directory, selection, offset })).toString('base64url') } };
}
function read(selection: McpDiscoveryQuery) { return { tool: 'mcp_discover', arguments: selection }; }
function pointer(value: unknown, path: string): unknown {
    if (path === '')
        return value;
    if (!path.startsWith('/'))
        throw new McpDiscoveryError('mcp_discovery_path_invalid');
    for (const key of path.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!object(value) && !Array.isArray(value))
            throw new McpDiscoveryError('mcp_discovery_path_missing');
        value = Object.hasOwn(value, key) ? (value as Json)[key] : undefined;
    }
    if (value === undefined)
        throw new McpDiscoveryError('mcp_discovery_path_missing');
    return value;
}
interface DiscoveryInput {
    args: Json;
    tools: readonly (McpAuthorityTool | McpCachedTool)[];
    servers: readonly McpAuthorityServerReadiness[];
    services: readonly McpAuthorityService[];
    provenance: unknown;
    budget?: number | null | undefined;
    unavailableWorkspaceScope?: unknown;
    readiness?: {
        configErrorCount: number;
        configuredServerCount: number;
        connectedServerCount: number;
        cachedToolCount: number;
    };
}
interface IndexedTool {
    identity: string;
    text: string;
}
export function createMcpDiscoveryReader() {
    let index = new Map<string, IndexedTool>();
    return (input: DiscoveryInput): Json => {
        const current = new Map<string, IndexedTool>();
        const result = mcpDiscoveryResult(input, index, current);
        index = current;
        return result;
    };
}
export function mcpDiscoveryResult(input: DiscoveryInput, previous = new Map<string, IndexedTool>(), current = new Map<string, IndexedTool>()): Json {
    const selection = mcpDiscoverySelection(input.args);
    const indexed = new Map(input.tools.map(tool => {
        const identity = JSON.stringify('schemaVersion' in tool ? [tool.server, tool.name, tool.schemaVersion] : tool);
        const value = previous.get(identity) ?? { identity: createHash('sha256').update(identity).digest('hex'), text: `${tool.name} ${tool.description} ${schemaTerms(tool.inputSchema)}` };
        current.set(identity, value);
        return [tool, value] as const;
    }));
    const directory = createHash('sha256').update(JSON.stringify([input.provenance, [...indexed.values()].map(value => value.identity).sort(), input.servers.map(server => [server.name, server.exposure]).sort(), input.services])).digest('hex');
    let offset = 0;
    if (typeof input.args.cursor === 'string') {
        const cursor = decode(input.args.cursor);
        if (cursor.directory !== directory)
            return { status: 'directory_changed', message: 'The retained MCP directory changed. Repeat the original query.', query: cursor.selection };
        offset = cursor.offset;
    }
    const fits = (value: unknown) => input.budget == null || size(value) <= input.budget;
    const targetArgs = (tool: McpAuthorityTool | McpCachedTool) => ({ server: tool.server, tool: tool.tool });
    const toolSummary = (tool: McpAuthorityTool | McpCachedTool): Json => ({
        server: tool.server, tool: tool.tool, name: tool.name, description: tool.description,
        ...('schemaVersion' in tool ? { schemaVersion: tool.schemaVersion, taskSupport: tool.taskSupport, taskCapable: tool.taskCapable, ...(tool.problem ? { problem: tool.problem } : {}) } : { cached: true, readiness: 'not_prepared' }),
        describe: read(targetArgs(tool)),
    });
    const detail = (tool: McpAuthorityTool | McpCachedTool): Json => ({ ...toolSummary(tool), view: 'complete', inputSchema: tool.inputSchema,
        ...('outputSchema' in tool && tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        invocation: 'schemaVersion' in tool ? { tool: 'mcp_call', arguments: { server: tool.server, tool: tool.tool, schemaVersion: tool.schemaVersion, arguments: {} } } : undefined });
    const targets = input.tools.filter(tool => !selection.server || tool.server === selection.server);
    const exactCandidates = selection.tool ? targets.filter(tool => tool.tool === selection.tool || tool.name === selection.tool) : [];
    const queryNames = selection.query ? targets.filter(tool => tool.name === selection.query || Boolean(selection.server) && tool.tool === selection.query) : [];
    const exact = selection.tool ? exactCandidates.length === 1 ? exactCandidates[0] : undefined : queryNames.length === 1 ? queryNames[0] : undefined;
    if (selection.tool && !exactCandidates.length)
        return { status: 'no_matches', scope: selection.server ? 'selected_server' : 'known_tools', server: selection.server, tool: selection.tool };
    if (exact && selection.detail !== 'summary') {
        const document = detail(exact);
        if (selection.path !== undefined) {
            const value = pointer(document, selection.path);
            const fragment = { name: exact.name, view: 'fragment', path: selection.path, value };
            if (offset === 0 && fits(fragment))
                return fragment;
            if (object(value) || Array.isArray(value)) {
                const nodes = Object.entries(value).map(([key, item]) => ({ key, type: Array.isArray(item) ? 'array' : typeof item,
                    read: read({ ...targetArgs(exact), path: `${selection.path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` }) }));
                return page({ name: exact.name, view: 'structure', path: selection.path }, 'nodes', nodes);
            }
            const text = JSON.stringify(value);
            if (offset > text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset]!))
                throw new McpDiscoveryError('mcp_discovery_cursor_invalid');
            const textFragment = (end: number): Json => ({ name: exact.name, view: 'json_text_fragment', path: selection.path, offset, text: text.slice(offset, end), ...(end < text.length ? { next: next(directory, selection, end) } : {}) });
            let lo = offset, hi = text.length;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (fits(textFragment(mid)))
                    lo = mid;
                else
                    hi = mid - 1;
            }
            if (lo < text.length && /[\uDC00-\uDFFF]/.test(text[lo]!))
                lo--;
            return lo === offset ? { status: 'budget_too_small', message: 'The exact fragment and continuation exceed the visible output budget.' } : textFragment(lo);
        }
        if (fits(document))
            return document;
        return { ...toolSummary(exact), description: undefined, view: 'overview', contract: read({ ...targetArgs(exact), path: '' }),
            descriptionRead: read({ ...targetArgs(exact), path: '/description' }), message: 'The complete contract exceeds this output budget. Read its exact schema structure.' };
    }
    const ranked = (selection.tool ? exactCandidates : targets).map(tool => ({ tool, rank: selection.query ? score(selection.query, indexed.get(tool)!.text) : 1 })).filter(item => item.rank > 0)
        .sort((a, b) => b.rank - a.rank || a.tool.name.localeCompare(b.tool.name));
    const records: Json[] = [];
    if (!selection.server)
        for (const server of input.servers.filter(server => server.exposure !== 'hidden' && server.status !== 'disabled' && (!selection.query || score(selection.query, `${server.name} ${server.description}`) > 0)).sort((a, b) => a.name.localeCompare(b.name))) {
            records.push({ kind: 'server', name: server.name, description: server.description, status: server.status,
                discovered: server.status === 'connected', cachedToolCount: server.cachedToolCount, toolCount: server.connectedToolCount,
                discover: read({ server: server.name }) });
        }
    for (const { tool } of ranked) {
        let value = selection.detail === 'full' ? detail(tool) : toolSummary(tool);
        // A single unusually large original description/schema remains explicitly addressable.
        const wrapper = { scope: 'discovered_tools', directory, total: records.length + ranked.length, entries: [value], next: next(directory, selection, records.length + ranked.length) };
        if (!fits(wrapper))
            value = { ...toolSummary(tool), description: undefined, view: 'overview', contract: read({ ...targetArgs(tool), path: '/inputSchema' }), descriptionRead: read({ ...targetArgs(tool), path: '/description' }) };
        records.push({ kind: 'tool', ...value });
    }
    for (const service of input.services)
        records.push({ kind: 'service', server: service.server, serviceKind: service.kind, schemaVersion: service.schemaVersion,
            ...(service.subscribe !== undefined ? { subscribe: service.subscribe } : {}) });
    return page({ status: ranked.length ? 'available' : selection.query ? 'no_matches' : 'available', scope: selection.server ? 'selected_server' : 'configured_servers_and_known_tools',
        coverage: selection.server ? 'Selected server catalog; other servers are not connected.' : 'Unprepared server contents have not been searched.',
        ...(input.readiness ? { readiness: input.readiness } : {}),
        ...(input.unavailableWorkspaceScope ? { unavailableWorkspaceScope: input.unavailableWorkspaceScope } : {}) }, 'entries', records);
    function page(envelope: Json, key: string, records: Json[]): Json {
        if (offset > records.length)
            throw new McpDiscoveryError('mcp_discovery_cursor_invalid');
        const rows: Json[] = [];
        const result: Json = { ...envelope, directory, total: records.length, [key]: rows };
        for (let i = offset; i < records.length; i++) {
            rows.push(records[i]!);
            if (i + 1 < records.length)
                result.next = next(directory, selection, i + 1);
            else
                delete result.next;
            if (!fits(project(result)) && rows.length === 1 && records[i]!.kind === 'tool') {
                const row = records[i]!;
                rows[0] = { kind: 'tool', server: row.server, tool: row.tool, name: row.name, view: 'overview',
                    ...(row.schemaVersion ? { schemaVersion: row.schemaVersion } : { cached: true, readiness: 'not_prepared' }),
                    describe: read({ server: row.server as string, tool: row.tool as string }), contract: read({ server: row.server as string, tool: row.tool as string, path: '' }) };
            }
            const requiredBytes = size(project(result));
            if (input.budget != null && requiredBytes > input.budget) {
                rows.pop();
                result.next = next(directory, selection, i);
                if (i === offset)
                    return { status: 'budget_too_small', requiredBytes, message: 'Read a narrower server, tool or exact schema path.' };
                break;
            }
        }
        // Preserve the existing tool/service result readers while paginating all entry kinds together.
        return project(result);
        function project(value: Json): Json {
            if (key !== 'entries')
                return value;
            const { entries: _entries, ...envelope } = value;
            return { ...envelope,
                tools: rows.filter(row => row.kind === 'tool').map(({ kind: _kind, ...row }) => row),
                servers: rows.filter(row => row.kind === 'server').map(({ kind: _kind, ...row }) => row),
                services: rows.filter(row => row.kind === 'service').map(({ kind: _kind, serviceKind, ...row }) => ({ ...row, kind: serviceKind })) };
        }
    }
}
