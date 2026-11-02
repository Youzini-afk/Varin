import type {
  query,
  Query,
  SDKUserMessage,
  PermissionResult,
  Options,
} from '@anthropic-ai/claude-agent-sdk/core';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { record, text, type RecordValue } from './transport.js';

type NativeCorrelation = {
  turnId: string;
  toolId: string;
  signal: AbortSignal;
  finish(matched: boolean): void;
};

/** Testable SDK-side owner; the worker below owns only JSONL framing. */
export class ClaudeBridge {
  private session?: Query;
  private sessionId = '';
  private readonly queue: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  private failure?: Error;
  private turnId: string | undefined;
  private boundTurn: string | undefined;
  private unprovenNotice = false;
  private turnControl = new AbortController();
  private readonly nativeTools = new Set<string>();
  private readonly foreignTools = new Set<string>();
  private readonly correlations = new Set<NativeCorrelation>();
  private readonly approvals = new Map<string, (value: PermissionResult) => void>();
  private current: { model?: string } = {};
  constructor(
    private readonly createQuery: typeof query,
    private readonly emit: (message: unknown) => void,
    private readonly fatal: (error: Error) => void,
  ) {}

  private async *inputs(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.queue.length)
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      while (!this.closed && this.queue.length) yield this.queue.shift()!;
    }
  }
  private correlate(turnId: string, toolId: string, signal: AbortSignal): Promise<boolean> {
    if (
      this.closed ||
      this.failure ||
      signal.aborted ||
      this.turnId !== turnId ||
      this.foreignTools.has(toolId)
    )
      return Promise.resolve(false);
    if (this.boundTurn === turnId && this.nativeTools.has(toolId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const finish = (matched: boolean) => {
        if (!this.correlations.delete(pending)) return;
        signal.removeEventListener('abort', abort);
        resolve(matched);
      };
      const abort = () => finish(false);
      const pending: NativeCorrelation = { turnId, toolId, signal, finish };
      this.correlations.add(pending);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) finish(false);
      else
        this.emit({
          jsonrpc: '2.0',
          method: 'notice',
          params: {
            sessionId: this.sessionId,
            turnId,
            message:
              'Waiting to correlate a native Claude permission with the current input. No approval will be requested until the matching native user UUID and tool event arrive. If this CLI does not supply that evidence, update Claude Code on this execution Host or stop this turn.',
          },
        });
    });
  }
  private projectCorrelations() {
    for (const pending of [...this.correlations]) {
      if (
        this.closed ||
        this.failure ||
        pending.signal.aborted ||
        pending.turnId !== this.turnId ||
        this.foreignTools.has(pending.toolId)
      )
        pending.finish(false);
      else if (this.boundTurn === pending.turnId && this.nativeTools.has(pending.toolId))
        pending.finish(true);
    }
  }
  private withdrawCorrelations() {
    for (const pending of [...this.correlations]) pending.finish(false);
  }
  private toolIds(event: RecordValue): string[] {
    const nativeEvent = record(event.event);
    const blocks =
      event.type === 'assistant' && Array.isArray(record(event.message).content)
        ? (record(event.message).content as unknown[])
        : nativeEvent.type === 'content_block_start'
          ? [nativeEvent.content_block]
          : [];
    return blocks.flatMap((value) => {
      const block = record(value);
      return block.type === 'tool_use' && text(block.id) ? [text(block.id)] : [];
    });
  }
  private die(value: unknown) {
    if (this.failure || this.closed) return;
    const error = value instanceof Error ? value : new Error(String(value));
    this.failure = error;
    try {
      this.close();
    } catch {
      /* Fatal reporting must survive SDK cleanup failure. */
    }
    this.emit({ jsonrpc: '2.0', method: 'failure', params: { message: error.message } });
    this.fatal(error);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.turnControl.abort();
    this.withdrawCorrelations();
    this.queue.length = 0;
    this.wake?.();
    this.wake = undefined;
    for (const approve of [...this.approvals.values()])
      approve({ behavior: 'deny', message: 'The Claude session ended' });
    this.approvals.clear();
    this.session?.close();
  }
  respond(message: RecordValue) {
    const approve = this.approvals.get(String(message.id));
    this.approvals.delete(String(message.id));
    approve?.(
      message.error
        ? { behavior: 'deny', message: 'The interaction was cancelled' }
        : (message.result as PermissionResult),
    );
  }
  async handle(message: RecordValue): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Claude bridge is closed');
    const p = record(message.params);
    if (message.method === 'initialize') {
      if (this.session) throw new Error('Claude bridge is already initialized');
      this.sessionId = text(p.sessionId) || randomUUID();
      const launcher = record(p.launcher),
        startupArgs = Array.isArray(launcher.args) ? launcher.args.map(String) : [];
      const options: Options = {
        cwd: text(p.cwd),
        pathToClaudeCodeExecutable: text(launcher.command),
        spawnClaudeCodeProcess: (args) =>
          spawn(text(launcher.command), [...startupArgs, ...args.args], {
            cwd: args.cwd,
            env: args.env,
            signal: args.signal,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        ...(p.sessionId ? { resume: this.sessionId } : { sessionId: this.sessionId }),
        canUseTool: async (name, input, options) => {
          const turnId = this.turnId;
          const signal = AbortSignal.any([options.signal, this.turnControl.signal]);
          if (!turnId || this.closed || signal.aborted)
            return { behavior: 'deny', message: 'The interaction has no active Claude turn' };
          // SDK 0.3.316 dispatches controls independently of its queued message
          // iterator. Await exact evidence rather than denying healthy callbacks
          // just because the bridge consumer has not projected that event yet.
          const correlated = await this.correlate(turnId, options.toolUseID, signal);
          if (!correlated || this.turnId !== turnId || this.closed || signal.aborted) {
            const reason =
              'Cannot correlate this native Claude permission to the current input, or its original turn ended. The request was denied by the bridge, not by the user. Update the Claude Code CLI on this execution Host if it does not supply native UUID/tool evidence.';
            this.emit({
              jsonrpc: '2.0',
              method: 'notice',
              params: { sessionId: this.sessionId, turnId, message: reason },
            });
            return { behavior: 'deny', message: reason };
          }
          this.emit({
            jsonrpc: '2.0',
            method: 'notice',
            params: {
              sessionId: this.sessionId,
              turnId,
              message: 'Native Claude permission matched to the current input.',
            },
          });
          const id = randomUUID();
          return new Promise<PermissionResult>((resolve) => {
            const complete = (value: PermissionResult) => {
              this.approvals.delete(id);
              signal.removeEventListener('abort', cancel);
              resolve(value);
            };
            const cancel = () => {
              this.emit({
                jsonrpc: '2.0',
                method: 'permission_cancelled',
                params: { sessionId: this.sessionId, turnId, id },
              });
              complete({ behavior: 'deny', message: 'The interaction was cancelled' });
            };
            this.approvals.set(id, complete);
            signal.addEventListener('abort', cancel, { once: true });
            this.emit({
              jsonrpc: '2.0',
              id,
              method: 'permission',
              params: {
                sessionId: this.sessionId,
                turnId,
                name,
                input,
                suggestions: options.suggestions,
                toolUseId: options.toolUseID,
              },
            });
            if (signal.aborted) cancel();
          });
        },
      };
      try {
        this.session = this.createQuery({ prompt: this.inputs(), options });
        void this.read(this.session);
        const initialized = await this.session.initializationResult();
        if (this.failure) throw this.failure;
        return {
          sessionId: this.sessionId,
          bridgeProtocol: 2,
          models: initialized.models,
          commands: initialized.commands,
          agentVersion: initialized.claude_code_version,
          current: this.current,
        };
      } catch (error) {
        this.die(error);
        throw error;
      }
    }
    if (!this.session) throw new Error('Claude bridge has not initialized');
    if (message.method === 'configure') {
      if (this.turnId) throw new Error('Claude is already running');
      if (p.mode !== undefined || Object.keys(record(p.config)).length)
        throw new Error('Claude does not expose these configuration controls');
      if (
        p.thinking !== undefined &&
        !['low', 'medium', 'high', 'xhigh', 'max'].includes(text(p.thinking))
      )
        throw new Error('Unsupported Claude effort level');
      if (typeof p.model === 'string') {
        const previous = this.current;
        await this.session.setModel(p.model);
        // setModel accepts aliases but returns no effective-model receipt. A
        // prior model is no longer current; wait for the next native init.
        if (this.current === previous) this.current = {};
      }
      if (p.thinking !== undefined)
        await this.session.applyFlagSettings({
          effortLevel: p.thinking as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
        });
      if (this.failure) throw this.failure;
      // Effort can be clamped by organization/model policy. Do not report the
      // requested effort as the effective one when the SDK supplies no receipt.
      return { current: this.current };
    }
    if (message.method === 'prompt') {
      if (this.turnId) throw new Error('Claude is already running');
      const uuid = text(p.uuid);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid))
        throw new Error('Claude prompt requires its admission identity');
      const content: SDKUserMessage['message']['content'] = [
        { type: 'text', text: text(p.text) },
        ...(Array.isArray(p.images) ? p.images : []).map((value) => {
          const image = record(value),
            mime = text(image.mimeType);
          if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime))
            throw new Error('Unsupported image type');
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
              data: text(image.data),
            },
          };
        }),
      ];
      this.turnId = uuid;
      this.turnControl = new AbortController();
      this.boundTurn = undefined;
      this.unprovenNotice = false;
      this.nativeTools.clear();
      this.foreignTools.clear();
      this.queue.push({
        type: 'user',
        uuid: uuid as ReturnType<typeof randomUUID>,
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: this.sessionId,
      });
      this.wake?.();
      this.wake = undefined;
      return { accepted: true, turnId: uuid };
    }
    if (message.method === 'interrupt') {
      this.turnControl.abort();
      this.withdrawCorrelations();
      const queued = this.queue.findIndex((message) => message.uuid === this.turnId);
      if (queued >= 0) {
        const turnId = this.turnId;
        this.queue.splice(queued, 1);
        this.turnId = undefined;
        // This is a bridge delivery receipt, not a fabricated native SDK result.
        this.emit({
          jsonrpc: '2.0',
          method: 'admission_cancelled',
          params: { sessionId: this.sessionId, turnId },
        });
        return { cancelledBeforeNativeDelivery: true };
      }
      // Resolve native permission callbacks before waiting for interrupt, which
      // itself can wait for those tools. Never turn intent into a result.
      for (const approve of [...this.approvals.values()])
        approve({ behavior: 'deny', message: 'The interaction was cancelled' });
      await this.session.interrupt();
      return {};
    }
    throw new Error(`Unsupported Claude bridge method: ${text(message.method)}`);
  }
  private async read(session: Query) {
    try {
      for await (const raw of session) {
        const event = record(raw);
        if (text(event.session_id) && event.session_id !== this.sessionId)
          throw new Error('Claude changed the selected native session identity');
        if (event.type === 'system' && event.subtype === 'init') {
          this.current = { ...(text(event.model) ? { model: text(event.model) } : {}) };
          this.emit({
            jsonrpc: '2.0',
            method: 'capabilities',
            params: {
              sessionId: this.sessionId,
              current: this.current,
              agentVersion: text(event.claude_code_version),
            },
          });
        }
        if (event.type === 'system' && event.subtype === 'commands_changed')
          this.emit({
            jsonrpc: '2.0',
            method: 'capabilities',
            params: { sessionId: this.sessionId, commands: event.commands },
          });
        const turnId = this.turnId;
        if (!turnId) continue;
        const user = text(event.user_message_uuid);
        if (user)
          this.boundTurn =
            user === turnId ||
            (Array.isArray(event.user_message_uuids) && event.user_message_uuids.includes(turnId))
              ? turnId
              : user;
        if (!this.boundTurn) {
          if (
            !this.unprovenNotice &&
            ['assistant', 'stream_event', 'user', 'result'].includes(text(event.type))
          ) {
            this.unprovenNotice = true;
            this.emit({
              jsonrpc: '2.0',
              method: 'notice',
              params: {
                sessionId: this.sessionId,
                turnId,
                message:
                  'Waiting for Claude to identify this native input UUID. Uncorrelated output and completion are not assigned to the current turn. If this CLI cannot supply native UUID evidence, update Claude Code on this execution Host or stop this turn.',
              },
            });
          }
          continue;
        }
        const toolIds = this.toolIds(event);
        if (this.boundTurn && this.boundTurn !== turnId) {
          for (const id of toolIds) this.foreignTools.add(id);
          this.projectCorrelations();
          continue;
        }
        const parent = text(event.parent_tool_use_id);
        if (parent && !this.nativeTools.has(parent)) continue;
        if (this.boundTurn === turnId) for (const id of toolIds) this.nativeTools.add(id);
        this.projectCorrelations();
        this.emit({
          jsonrpc: '2.0',
          method: 'message',
          params: { sessionId: this.sessionId, turnId, message: event },
        });
        if (event.type === 'result') {
          this.turnId = undefined;
          this.turnControl.abort();
          this.withdrawCorrelations();
        }
      }
      if (!this.closed)
        this.die(new Error('Claude SDK query ended unexpectedly; reconnect the native session'));
    } catch (error) {
      this.die(error);
    }
  }
}
