import { createHash } from 'node:crypto';
import type { NativeThreadIdentity, NativeThreadSubmit, NativeThreadSource, NativeThreadSnapshot } from '@varin/application-client';
import type { NativeInputMode, NativeModelSessionConfiguration, NativeCredentialScope, NativeRuntimeStreamEvent } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { NativeRuntimeClient } from './native-runtime-client.js';

export interface NativeThreadModelAuthority {
  listModels?(): Promise<Array<{ providerId: string; modelId: string; name?: string }>>;
  resolveModel(selection: { providerId: string; modelId: string }): Promise<{ configuration: NativeModelSessionConfiguration; credentialOwner: ExistingHostCredentialOwner }>;
  rebindModel(configuration: NativeModelSessionConfiguration, expectedScope: NativeCredentialScope): Promise<ExistingHostCredentialOwner>;
}

/** Projection and admission only: Rust owns all conversation, queue and execution facts. */
export class NativeThreadAdapter {
  constructor(readonly runtime: NativeRuntimeClient, private readonly models: NativeThreadModelAuthority,
    private readonly admitSource: (source: NativeThreadSource) => Promise<void>,
    private readonly onLaunchError: (runId: string, error: unknown) => void) {}

  async listModels() {
    if (!this.models.listModels) throw new Error('Model catalog is unavailable');
    return this.models.listModels();
  }

  async create(key: string): Promise<NativeThreadIdentity> {
    const digest = createHash('sha256').update(key).digest('hex');
    const identity: NativeThreadIdentity = { runtime: 'nativeThread', threadId: `nativeThread:${digest}`, branchId: `nativeBranch:${digest}` };
    await this.runtime.createThread(identity.threadId, identity.branchId);
    return identity;
  }

  assertIdentity(identity: NativeThreadIdentity): void {
    if (identity.runtime !== 'nativeThread' || !identity.threadId.startsWith('nativeThread:') || !identity.branchId.startsWith('nativeBranch:')) {
      throw new Error('An explicit nativeThread identity is required');
    }
  }

  async submit(input: NativeThreadSubmit) {
    await this.requireIdentity(input);
    if (input.source) await this.admitSource(input.source);
    const model = await this.models.resolveModel(input.model);
    // The same Rust transaction accepts input and pins source/credential/tool selection.
    const receipt = await this.runtime.submit({ key: input.key, threadId: input.threadId, branchId: input.branchId,
      expectedHead: input.expectedHead, input: { text: input.text }, configuration: model.configuration,
      launch: { source: input.source ? {
        workspaceId: input.source.workspaceId, executionWorkspaceId: input.source.executionWorkspaceId,
        branchId: input.source.branchId, revision: input.source.revision, materialized: input.source.mode === 'materialized',
      } : null, enabledTools: input.source?.tools ?? [], credentialScope: await model.credentialOwner.scope() },
    });
    const run = await this.runtime.run(receipt.run_id);
    if (run.state === 'accepted' || run.state === 'preparing' || run.state === 'runnable') {
      const launch = input.source
        ? this.runtime.startFromSource({ runId: receipt.run_id, ...input.source }, { credentialOwner: model.credentialOwner })
        : this.runtime.startRunWithCredentialOwner(receipt.run_id, model.credentialOwner);
      void launch.catch(error => this.recordLaunchFailure(receipt.run_id, error));
    }
    return receipt;
  }

  async enqueue(input: NativeThreadIdentity & { key: string; text: string; mode: NativeInputMode }) {
    await this.requireIdentity(input);
    const thread = await this.runtime.thread(input.threadId);
    const branch = thread.branches.find(candidate => candidate.branch_id === input.branchId)!;
    const previous = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : branch.latest_run;
    if (!previous) throw new Error('An initial model selection is required');
    const receipt = await this.runtime.enqueue({ key: input.key, threadId: input.threadId, branchId: input.branchId,
      mode: input.mode, input: { text: input.text }, configuration: previous.configuration });
    const launch = await this.runtime.launch(receipt.run_id);
    if (launch?.requires_rebind) {
      const run = await this.runtime.run(receipt.run_id);
      if (!launch.selection.credential_scope) throw new Error('Selected credential binding is unavailable');
      const owner = await this.models.rebindModel(run.configuration as NativeModelSessionConfiguration, launch.selection.credential_scope);
      try { await this.runtime.rebindLaunch(receipt.run_id, { credentialOwner: owner }); }
      catch (error) { await this.recordLaunchFailure(receipt.run_id, error); throw error; }
    }
    return receipt;
  }

  async requireIdentity(identity: NativeThreadIdentity): Promise<void> {
    this.assertIdentity(identity);
    const thread = await this.runtime.thread(identity.threadId);
    if (!thread.branches.some(branch => branch.branch_id === identity.branchId)) throw new Error('Native branch does not belong to the selected thread');
  }

  async requireRun(runId: string) {
    const run = await this.runtime.run(runId);
    if (!run.thread_id.startsWith('nativeThread:')) throw new Error('Run is not owned by a nativeThread');
    return run;
  }

  async requireInput(inputId: string) {
    const input = await this.runtime.input(inputId);
    if (!input.thread_id.startsWith('nativeThread:')) throw new Error('Input is not owned by a nativeThread');
    return input;
  }

  async requireOperation(operationId: string) {
    const operation = await this.runtime.operation(operationId);
    await this.requireRun(operation.run_id);
    return operation;
  }

  async snapshot(identity: NativeThreadIdentity): Promise<NativeThreadSnapshot> {
    await this.requireIdentity(identity);
    const [thread, history, inputs] = await Promise.all([this.runtime.thread(identity.threadId), this.runtime.history(identity.branchId), this.runtime.inputs(identity.branchId)]);
    if (history.some(item => item.thread_id !== identity.threadId) || inputs.some(item => item.thread_id !== identity.threadId)) {
      throw new Error('Native branch does not belong to the selected thread');
    }
    const operationIds = new Set<string>();
    for (const item of history) {
      const conversation = item.content as { content?: { kind?: string; result?: { completion?: { kind?: string; operation_id?: string } } } };
      const completion = conversation?.content?.kind === 'tool_result' ? conversation.content.result?.completion : undefined;
      if (completion?.kind === 'job_accepted' && typeof completion.operation_id === 'string') operationIds.add(completion.operation_id);
    }
    const operations = await Promise.all([...operationIds].map(id => this.requireOperation(id)));
    const branch = thread.branches.find(branch => branch.branch_id === identity.branchId)!;
    const latest = branch.latest_run;
    const activeRun = branch.active_run_id ? await this.runtime.run(branch.active_run_id) : null;
    const launch = latest ? await this.runtime.launch(latest.id) : null;
    return { identity, thread, activeRun, history, inputs, operations, launch };
  }

  private async recordLaunchFailure(runId: string, error: unknown): Promise<void> {
    try { await this.runtime.failLaunch(runId, 'preparation_failed'); }
    catch (recordError) { this.onLaunchError(runId, recordError); }
    this.onLaunchError(runId, error);
  }

  async recover(): Promise<void> {
    const pending = await this.runtime.pendingLaunches();
    await Promise.all(pending.map(async launch => {
      const run = await this.runtime.run(launch.run_id);
      if (!run.thread_id.startsWith('nativeThread:') || ['completed', 'failed', 'cancelled'].includes(run.state)) return;
      try { await this.resume(run.id); }
      catch (error) { await this.recordLaunchFailure(run.id, error); }
    }));
  }

  async resume(runId: string): Promise<void> {
    const run = await this.runtime.run(runId);
    if (!run.thread_id.startsWith('nativeThread:')) throw new Error('Run is not owned by a nativeThread');
    const launch = await this.runtime.launch(runId);
    if (!launch?.selection.credential_scope) throw new Error('Run has no durable credential binding; resubmit its original input key');
    const owner = await this.models.rebindModel(run.configuration as NativeModelSessionConfiguration, launch.selection.credential_scope);
    await this.runtime.rebindLaunch(runId, { credentialOwner: owner });
  }

  /** Listener registration precedes replay. Notifications only wake the durable cursor reader. */
  observe(cursor: number, emit: (event: unknown) => boolean, fail: (error: unknown) => void): () => void {
    let closed = false;
    let reading = false;
    let dirty = false;
    const replay = async () => {
      dirty = true;
      if (reading || closed) return;
      reading = true;
      try {
        while (!closed && dirty) {
          dirty = false;
          let events;
          do {
            events = await this.runtime.events(cursor, 256);
            for (const event of events) {
              if (closed) return;
              if (!emit(event)) { close(); return; }
              cursor = event.cursor;
            }
          } while (!closed && events.length === 256);
        }
      } catch (error) { close(); fail(error); }
      finally { reading = false; }
    };
    const remove = this.runtime.onEvent((event: NativeRuntimeStreamEvent) => {
      if (event.stream === 'durable') void replay();
      else if (!closed) {
        try { if (!emit(event)) close(); }
        catch (error) { close(); fail(error); }
      }
    });
    const removeExit = this.runtime.onExit(error => { close(); fail(error); });
    const close = () => { closed = true; remove(); removeExit(); };
    void replay();
    return close;
  }
}
