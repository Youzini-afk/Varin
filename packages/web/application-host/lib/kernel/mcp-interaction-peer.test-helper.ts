/** Controlled MCP receiver used by the original-owner integration chain.
 * HTTP uses the installed transport with in-memory fetch; stdio is a real child process.
 * No listener, external service, browser or model is opened. */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type Send = (message: Message) => void;
interface Task { id: string; scenario: string; createdAt: string; lastUpdatedAt: string; status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'; response?: unknown; errorObserved?: boolean; pending?: { request: Message; send: Send }; }
const form = {
  message: 'Original receiver asks for reviewable typed values. This is remote content, not a tool permission.',
  requestedSchema: { type: 'object', properties: {
    enabled: { type: 'boolean', title: 'Enabled', default: true },
    count: { type: 'integer', title: 'Count', minimum: 0, maximum: 5, default: 3 },
    note: { type: 'string', title: 'Note', maxLength: 30, default: 'editable default' },
    tags: { type: 'array', title: 'Tags', items: { anyOf: [{ const: 'one', title: 'First' }, { const: 'two', title: 'Second' }] }, minItems: 1, maxItems: 2 },
  }, required: ['enabled', 'count', 'note', 'tags'] },
  _meta: { original: 'remote-form', opaque: { empty: [], nullable: null } },
};

export class InteractionPeer {
  readonly messages: Message[] = [];
  readonly tasks = new Map<string, Task>();
  private readonly questions = new Map<string | number, { request: Message; send: Send; task?: Task; mode: string }>();
  private sequence = 0;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    const path = join(root, 'interaction-tasks.json');
    if (existsSync(path)) for (const task of JSON.parse(readFileSync(path, 'utf8')) as Task[]) this.tasks.set(task.id, task);
  }
  private saveTasks() { writeFileSync(join(this.root, 'interaction-tasks.json'), JSON.stringify([...this.tasks.values()].map(({ pending: _pending, ...task }) => task))); }
  private trace(value: unknown) { appendFileSync(join(this.root, 'interaction-trace.jsonl'), `${JSON.stringify(value)}\n`); }
  handle(request: Message, send: Send): void {
    this.messages.push(structuredClone(request)); this.trace({ kind: 'received', ...request });
    if (!request.method) {
      const question = this.questions.get(request.id!);
      if (!question) return;
      this.questions.delete(request.id!);
      this.trace({ kind: 'answered', requestId: request.id, response: request.result ?? { error: request.error } });
      if (question.task) {
        question.task.response = request.result ?? { error: request.error };
        question.task.status = 'completed'; question.task.lastUpdatedAt = new Date().toISOString(); this.saveTasks();
        if (question.task.pending) this.result(question.task.pending.request, question.task, question.task.pending.send);
      } else {
        question.send({ id: question.request.id!, result: { content: [{ type: 'text', text: 'Original RPC received its reviewed response' }],
          structuredContent: { reviewedResponse: request.result ?? { error: request.error } }, _meta: { original: 'rpc-after-interaction' } } });
      }
      // URL consent and the server's later completion are deliberately different messages.
      // Tests explicitly trigger completion rather than inferring it from this response.
      return;
    }
    if (request.id === undefined) return;
    const params = request.params ?? {};
    const reply = (result: unknown) => send({ id: request.id!, result });
    switch (request.method) {
      case 'initialize': {
        const capabilities = params.capabilities as { elicitation?: { form?: unknown; url?: unknown } };
        assert(capabilities.elicitation?.form && capabilities.elicitation.url, 'Original client must negotiate both implemented modes');
        reply({ protocolVersion: '2025-11-25', serverInfo: { name: 'original-interaction-receiver', version: '1' },
          capabilities: { tools: {}, tasks: { cancel: {}, requests: { tools: { call: {} } } } } }); return;
      }
      case 'ping': reply({}); return;
      case 'tools/list': reply({ tools: [
        { name: 'ordinary', description: 'Original finite interactive RPC', inputSchema: { type: 'object', properties: { scenario: { type: 'string' } }, required: ['scenario'] }, execution: { taskSupport: 'forbidden' } },
        { name: 'deferred', description: 'Original interactive Thread Task', inputSchema: { type: 'object', properties: { scenario: { type: 'string' } }, required: ['scenario'] }, execution: { taskSupport: 'required' } },
      ] }); return;
      case 'tools/call': {
        const scenario = String((params.arguments as { scenario: string }).scenario);
        if (scenario === 'creation-error') { this.error(request, send, scenario); return; }
        if (params.name === 'deferred') {
          assert(params.task, 'Original required Task was called as an ordinary RPC');
          const id = `receiver:${scenario}`; assert(!this.tasks.has(id), 'Original Task must not be submitted twice');
          const now = new Date().toISOString();
          const task: Task = { id, scenario, createdAt: now, lastUpdatedAt: now, status: 'working' };
          this.tasks.set(id, task); this.saveTasks(); reply({ task: this.state(task), _meta: { original: 'immutable-task-acceptance' } }); return;
        }
        assert.equal(params.name, 'ordinary'); assert.equal(params.task, undefined);
        if (scenario.startsWith('ordinary-error')) this.error(request, send, scenario);
        else this.ask(request, send, scenario); return;
      }
      case 'tasks/get': { const task = this.task(params); if (task.status === 'working') { task.status = task.scenario === 'terminal-error' ? 'failed' : 'input_required'; task.lastUpdatedAt = new Date().toISOString(); this.saveTasks(); } reply(this.state(task)); return; }
      case 'tasks/result': {
        const task = this.task(params);
        if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') this.result(request, task, send);
        else if (task.scenario === 'premature-error') {
          assert(!task.errorObserved, 'Original Task result must not be polled repeatedly while external input is outstanding');
          task.errorObserved = true; this.saveTasks(); this.error(request, send, task.scenario, task);
        }
        else { task.pending = { request, send }; this.ask(request, send, task.scenario, task); }
        return;
      }
      case 'tasks/cancel': {
        const task = this.task(params); task.status = 'cancelled'; task.lastUpdatedAt = new Date().toISOString(); this.saveTasks();
        reply(this.state(task)); return;
      }
      default: send({ id: request.id!, error: { code: -32601, message: 'Unsupported fixture method' } });
    }
  }
  complete(send: Send, elicitationId: string) {
    for (const task of this.tasks.values()) if (task.scenario === 'premature-error' && elicitationId.startsWith(`external-error:${task.scenario}:`)) {
      task.status = 'completed'; task.lastUpdatedAt = new Date().toISOString(); task.response = { externalStep: true }; this.saveTasks();
    }
    send({ method: 'notifications/elicitation/complete', params: { elicitationId } }); }
  private task(params: Record<string, unknown>) { const task = this.tasks.get(String(params.taskId)); assert(task); return task; }
  private state(task: Task) { return { taskId: task.id, status: task.status, createdAt: task.createdAt, lastUpdatedAt: task.lastUpdatedAt, ttl: null, pollInterval: 20 }; }
  private result(request: Message, task: Task, send: Send) {
    if (task.status === 'failed' && task.scenario === 'terminal-error') { this.error(request, send, task.scenario, task); return; }
    if (task.status === 'cancelled') { send({ id: request.id!, error: { code: -32000, message: 'Original task cancelled', data: { stopUnconfirmed: true } } }); return; }
    send({ id: request.id!, result: { content: [{ type: 'text', text: 'Original task completed after reviewed response' }],
      structuredContent: { reviewedResponse: task.response }, _meta: { original: 'task-after-interaction', 'io.modelcontextprotocol/related-task': { taskId: task.id } } } });
    delete task.pending;
  }
  private error(request: Message, send: Send, scenario: string, task?: Task) {
    const elicitations = ['review', 'continue'].map(part => ({ mode: 'url',
      message: `Original ${scenario} needs the ${part} external step.`,
      url: `https://receiver.invalid/error/${scenario}/${part}?rpc=${request.id}`,
      elicitationId: `external-error:${scenario}:${request.id}:${part}`,
    }));
    const error = { code: -32042, message: 'Original external interaction required',
      data: { elicitations, opaque: { nullable: null, empty: [], text: '原始正文🙂'.repeat(4096) } },
      originalExtra: { method: request.method, ...(task ? { taskId: task.id } : {}) } };
    this.trace({ kind: 'error-produced', requestId: request.id, error });
    send({ id: request.id!, error });
    if (scenario.includes('early-complete')) this.complete(send, elicitations[0]!.elicitationId);
  }
  private ask(request: Message, send: Send, scenario: string, task?: Task) {
    const id = this.sequence++ === 0 ? 1.5 : `elicitation:${this.sequence}`, mode = scenario.includes('url') ? 'url' : 'form';
    const sampling = scenario.startsWith('sampling-');
    const params: Record<string, unknown> = sampling ? {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Server original sampling input' }] },
        { role: 'assistant', content: { type: 'text', text: 'Server supplied assistant context' } },
        { role: 'user', content: { type: 'text', text: 'Respond using this isolated conversation' } }],
      systemPrompt: 'Server proposed isolated sampling instruction', maxTokens: 64, temperature: 0.25,
      modelPreferences: { hints: [{ name: 'unavailable-server-hint' }], costPriority: 0.9 },
      _meta: { original: 'server-sampling', scenario },
    } : mode === 'form' ? structuredClone(form) : {
      mode, message: 'Review this exact external URL before consenting.', url: `https://receiver.invalid/continue?interaction=${id}`, elicitationId: `external:${id}`,
    };
    if (task) params._meta = { ...(params._meta as Record<string, unknown> ?? {}), 'io.modelcontextprotocol/related-task': { taskId: task.id } };
    this.questions.set(id, { request, send, ...(task ? { task } : {}), mode });
    this.trace({ kind: 'asking', id, originalRequest: request.id, taskId: task?.id, params });
    send({ id, method: sampling ? 'sampling/createMessage' : 'elicitation/create', params });
  }
}

export function createInteractionHttpPeer(root: string) {
  const peer = new InteractionPeer(root);
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let notifications: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'GET') return new Response(new ReadableStream<Uint8Array>({
      start(controller) { notifications = controller; streams.add(controller); init.signal?.addEventListener('abort', () => {
        streams.delete(controller); if (notifications === controller) notifications = undefined;
        try { controller.close(); } catch { /* Original reader already closed. */ }
      }, { once: true }); },
    }), { headers: { 'content-type': 'text/event-stream' } });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body)) as Message;
    if (!request.method || request.id === undefined) {
      peer.handle(request, () => { throw new Error('Response must use its original response stream'); });
      return new Response(null, { status: 202 });
    }
    if (['tools/call', 'tasks/result'].includes(request.method)) {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        streams.add(controller);
        peer.handle(request, message => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`));
          if (!message.method && message.id === request.id) { streams.delete(controller); queueMicrotask(() => controller.close()); }
        });
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'original-fixture-session' } });
    }
    let result: Message | undefined; peer.handle(request, value => { result = value; });
    assert(result);
    return Response.json({ jsonrpc: '2.0', ...result }, { headers: { 'mcp-session-id': 'original-fixture-session' } });
  };
  return { peer, fetch, complete(elicitationId: string) { assert(notifications, 'Original HTTP GET notification stream must be connected'); peer.complete(message => notifications!.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', ...message })}\n\n`)), elicitationId); }, close() { for (const controller of streams) { try { controller.close(); } catch { /* Already cancelled by the original transport. */ } } streams.clear(); } };
}

export function writeInteractionStdioConfiguration(root: string) {
  const agentDir = join(root, 'agent'); mkdirSync(agentDir, { recursive: true });
  const loader = createRequire(import.meta.url).resolve('tsx');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { original: {
    command: process.execPath, args: ['--import', loader, fileURLToPath(import.meta.url), '--mcp-interaction-peer', root], exposure: 'direct',
  } } }));
  return agentDir;
}

if (process.argv[2] === '--mcp-interaction-peer') {
  const peer = new InteractionPeer(process.argv[3]!);
  const send: Send = message => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
  createInterface({ input: process.stdin }).on('line', line => peer.handle(JSON.parse(line) as Message, send));
}
