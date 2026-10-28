import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpAuthority, type McpAuthorityScope } from '../mcp/authority.js';
import { createMcpLease } from './mcp-owner.js';
import type { KernelClient } from './kernel-client.js';
import type { HostToolCall } from './tool-bridge.js';
it('discovers offline metadata, pages exact selected-server contracts and calls the original version without preparing other servers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'varin-discovery-'));
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { selected: { url: 'http://selected.test/mcp', exposure: 'deferred' }, other: { url: 'http://other.test/mcp', exposure: 'deferred' } } }));
    const requests: Array<{
        url: string;
        method: string;
    }> = [];
    const authority = new McpAuthority({ fetch: async (url, init) => {
            if (init?.method === 'GET')
                return new Response(null, { status: 405 });
            const request = JSON.parse(String(init?.body));
            requests.push({ url: String(url), method: request.method });
            const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: request.id, result });
            if (request.method === 'server/discover')
                return Response.json({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported' } }, { status: 404 });
            if (request.method === 'initialize')
                return reply({ protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
            if (request.method === 'tools/list')
                return reply({ tools: Array.from({ length: 40 }, (_, index) => ({ name: `inspect_${String(index).padStart(2, '0')}`, description: index === 0 ? 'Capture a screenshot of an application.' : index === 39 ? '文本😀'.repeat(200) : 'Inspect a retained object.',
                        inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' }, ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`optional_${i}`, { type: 'string' }])) } } })) });
            if (request.method === 'tools/call')
                return reply({ content: [{ type: 'text', text: `inspected ${request.params.arguments.id}` }] });
            return new Response(null, { status: 202 });
        } });
    const scope: McpAuthorityScope = { resourceOwner: { kind: 'local' }, agentDir: root, configCwd: root, executionCwd: root, executionScope: 'global', environmentId: 'fixture', sessionId: 'discovery', projectTrusted: false };
    const lease = await authority.acquire(scope, { servers: [] });
    const owner = createMcpLease({ lease, kernel: {} as KernelClient, currentPolicy: async () => ({ mode: 'bypass', rules: [] }) });
    const signal = new AbortController().signal;
    let count = 0;
    const call = (name: string, args: Record<string, unknown>, budget = 2048): HostToolCall => ({ runId: 'run', operationId: `operation-${++count}`, origin: { kind: 'model_step', request_id: 'request' }, callId: `call-${count}`, name, schemaVersion: '1', arguments: args, outputVisibleBytes: budget });
    const discover = async (args: Record<string, unknown>, budget = 2048) => {
        const request = call('mcp_discover', args, budget);
        await owner.authorize(request, signal);
        const receipt = await owner.execute(request, signal, { kind: 'kernel' });
        expect(receipt.completion.kind).toBe('result');
        if (receipt.completion.kind !== 'result')
            throw new Error('missing discovery result');
        // The assertions below inspect the actual open-ended JSON receipt.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = receipt.completion.content.data as Record<string, any>;
        expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(budget);
        return data;
    };
    try {
        const offline = await discover({});
        expect(offline.servers).toHaveLength(2);
        expect(requests).toHaveLength(0);
        let page = await discover({ server: 'selected' });
        const names: string[] = [];
        for (;;) {
            for (const tool of page.tools) {
                names.push(tool.tool);
                expect(tool).not.toHaveProperty('inputSchema');
            }
            if (!page.next)
                break;
            page = await discover(page.next.arguments);
        }
        expect(new Set(names).size).toBe(40);
        expect(names).toHaveLength(40);
        const search = await discover({ server: 'selected', query: '截图 屏幕' });
        expect(search.tools[0].tool).toBe('inspect_00');
        const details = await discover({ server: 'selected', tool: 'inspect_00' }, 4096);
        expect(details.view).toBe('complete');
        expect(details.inputSchema.required).toEqual(['id']);
        let structure = await discover({ server: 'selected', tool: 'inspect_00', path: '/inputSchema/properties' }, 1024);
        const keys: string[] = [];
        for (;;) {
            expect(structure.view).toBe('structure');
            keys.push(...structure.nodes.map((node: {
                key: string;
            }) => node.key));
            if (!structure.next)
                break;
            structure = await discover(structure.next.arguments, 1024);
        }
        expect(new Set(keys).size).toBe(31);
        let fragment = await discover({ server: 'selected', tool: 'inspect_39', path: '/description' }, 1024);
        let text = '';
        for (;;) {
            expect(fragment.view).toBe('json_text_fragment');
            text += fragment.text;
            if (!fragment.next)
                break;
            fragment = await discover(fragment.next.arguments, 1024);
        }
        expect(JSON.parse(text)).toBe('文本😀'.repeat(200));
        const invalidPath=call('mcp_discover',{server:'selected',tool:'inspect_00',path:'/missing'});
        await owner.authorize(invalidPath,signal);
        const invalid=await owner.execute(invalidPath,signal,{kind:'kernel'});
        expect(invalid.completion).toMatchObject({kind:'result',outcome:'failed',effect:'none',content:{data:{error:{code:'mcp_discovery_path_missing'}}}});
        const action = call('mcp_call', { server: details.server, tool: details.tool, schemaVersion: details.schemaVersion, arguments: { id: 'actual' } });
        await owner.authorize(action, signal);
        const result = await owner.execute(action, signal, { kind: 'kernel' });
        expect(JSON.stringify(result)).toContain('inspected actual');
        await expect(owner.authorize(call('mcp_call', { server: details.server, tool: details.tool, schemaVersion: 'stale', arguments: { id: 'actual' } }), signal)).rejects.toThrow();
        expect(requests.every(request => request.url.includes('selected.test'))).toBe(true);
    }
    finally {
        owner.release();
        await authority.close();
        await rm(root, { recursive: true, force: true });
    }
});
