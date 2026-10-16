import { createInteractiveUiHttpAPI, getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange, InteractiveUiError, type RenderUiInput, type UiReceipt, type UiSource } from '@varin/application-client';
import type { ChatToolCall } from '@/components/conversation/types';
import { formatMessage, useI18nStore, type I18nKey } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { PartialJson } from './partial-json';
import { updateUiSession, type UiSession } from './sessions';
const message = (key: I18nKey) => formatMessage(useI18nStore.getState().dictionary, key);

class WorkProjection {
  private reader = new PartialJson();
  private call?: ChatToolCall;
  private raw = '';
  private input: Partial<RenderUiInput> = {};
  private output: unknown;
  private running = false;
  private failed = false;
  private base?: UiSource;
  private target?: string;
  private loadedTarget?: string;
  private request?: AbortController;
  private error = '';
  private removeEndpoint: () => void;
  private readonly api: ReturnType<typeof createInteractiveUiHttpAPI>;
  constructor(readonly session: UiSession) {
    this.api = createInteractiveUiHttpAPI(session.host);
    this.removeEndpoint = subscribeRuntimeEndpointWillChange(() => this.close());
  }
  close() { this.request?.abort(); this.removeEndpoint(); }
  update(call: ChatToolCall, output: unknown, running: boolean, failed: boolean) {
    const same = this.call?.id === call.id && (call.rawArguments !== undefined ? this.raw === call.rawArguments : this.call?.arguments === call.arguments);
    if (same && this.output === output && this.running === running && this.failed === failed) return;
    if (this.call?.id !== call.id || call.rawArguments !== undefined && call.rawArguments.length < this.raw.length) { this.reader = new PartialJson(); this.raw = ''; }
    this.call = call; this.output = output; this.running = running; this.failed = failed;
    if (call.rawArguments !== undefined) { this.input = this.reader.feed(call.rawArguments.slice(this.raw.length)) as Partial<RenderUiInput> ?? {}; this.raw = call.rawArguments; }
    else this.input = call.arguments as Partial<RenderUiInput> ?? {};
    const saved = this.receipt();
    const target = saved?.ref ?? (call.rawArguments === undefined || this.reader.completeFields.has('ref') ? this.input.ref : undefined);
    if (target !== this.target) {
      this.target = target; this.request?.abort(); this.error = '';
      if (target) {
        const request = this.request = new AbortController();
        void this.load(target, request);
      } else { this.base = undefined; this.loadedTarget = undefined; }
    }
    this.publish();
  }
  private async load(target: string, request: AbortController) {
    while (!request.signal.aborted) try {
      const source = await this.api.source(this.session.identity, target, request.signal);
      if (request.signal.aborted || this.session.host !== getRuntimeEndpointGeneration()) return;
      this.error = ''; this.base = source; this.loadedTarget = target; this.session.source = source; this.publish(); return;
    } catch (failure) {
      if (request.signal.aborted) return;
      this.error = failure instanceof Error ? failure.message : 'Content could not be loaded'; this.publish();
      if (failure instanceof InteractiveUiError && failure.status < 500) return;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); request.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1_000); request.signal.addEventListener('abort', finish, { once: true });
        if (request.signal.aborted) finish();
      });
    }
  }
  async restore(ref: string) {
    const request = this.request = new AbortController();
    const source = await this.api.source(this.session.identity, ref, request.signal);
    if (request.signal.aborted || this.session.host !== getRuntimeEndpointGeneration()) return;
    this.base = source; this.loadedTarget = ref; this.target = ref;
    this.session.source = source;
    updateUiSession(this.session, { source: { ref: source.ref }, files: source.contents, assets: source.assets,
      title: source.title, entry: source.entry, committed: true, status: '' });
  }
  private receipt() {
    const value = this.output as UiReceipt | undefined;
    return value?.kind === 'ui' && typeof value.ref === 'string' ? value : undefined;
  }
  private publish() {
    if (!this.call) return;
    const saved = this.receipt(), base = this.loadedTarget === this.target ? this.base : undefined;
    if (!saved && this.target && !base && this.session.display) {
      updateUiSession(this.session, { ...this.session.display, status: this.error || message('ui.content.making') }); return;
    }
    let files: Record<string, string> = Object.assign(Object.create(null), base?.contents ?? {});
    if (!saved) for (const change of Array.isArray(this.input.changes) ? this.input.changes : []) {
      if (!change || typeof change.file !== 'string') continue;
      if (this.call.rawArguments !== undefined && (!this.reader.fieldComplete(change, 'file') || !this.reader.fieldComplete(change, 'op'))) continue;
      const file = relativeFile(change.file);
      if (change.op === 'write' && typeof change.text === 'string') files[file] = change.text;
      else if (change.op === 'append' && typeof change.text === 'string') files[file] = (files[file] ?? '') + change.text;
      else if (change.op === 'edit' && Array.isArray(change.edits) && files[file] !== undefined) files[file] = editPreview(files[file]!, change.edits.filter(edit => edit && (this.call!.rawArguments === undefined || this.reader.fieldComplete(edit, 'oldText'))));
      else if (change.op === 'delete') delete files[file];
    }
    if (saved && base?.ref !== saved.ref) files = this.session.display?.files ?? files;
    const title = saved?.title ?? this.input.title ?? base?.title ?? message('ui.content.title');
    const entry = relativeFile(saved?.entry ?? (this.call.rawArguments === undefined || this.reader.completeFields.has('entry') ? this.input.entry : undefined) ?? base?.entry ?? 'index.html');
    const committed = Boolean(saved && base?.ref === saved.ref);
    const source = committed ? { ref: saved!.ref } : { preview: { callId: this.call.id, sequence: this.call.sequence ?? 0, contents: files, entry, title, ...(base ? { baseRef: base.ref } : {}) } };
    updateUiSession(this.session, { source, files, assets: base?.assets ?? this.session.display?.assets ?? {}, title, entry, committed,
      status: this.error || (this.failed ? message('ui.content.unsaved') : this.running ? message('ui.content.making') : saved ? '' : message('ui.content.unsaved')) });
    if (committed && this.session.placement === 'panel' && this.session.panelDirectory) useUIStore.getState().openContextPanelTab(this.session.panelDirectory,
      { mode: 'ui', targetPath: this.session.key, thread: this.session.identity, contentRef: saved!.ref, label: title, dedupeKey: this.session.key });
  }
}
const projections = new WeakMap<UiSession, WorkProjection>();
const owner = (session: UiSession) => { let projection = projections.get(session); if (!projection) { projection = new WorkProjection(session); projections.set(session, projection); } return projection; };
export const projectUiWork = (session: UiSession, call: ChatToolCall, output: unknown, running: boolean, failed: boolean) => owner(session).update(call, output, running, failed);
export const restoreUiWork = (session: UiSession, ref: string) => owner(session).restore(ref);
export function releaseUiWork(session: UiSession) {
  if (session.cardMounted || session.placement === 'panel') return;
  projections.get(session)?.close(); projections.delete(session); delete session.source; delete session.display;
}
function relativeFile(file: string) { return file.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/'); }
function editPreview(text: string, edits: { oldText: string; newText: string }[]) {
  const matches = edits.filter(edit => typeof edit.oldText === 'string' && edit.oldText && typeof edit.newText === 'string').map(edit => ({ ...edit, start: text.indexOf(edit.oldText) }));
  if (matches.some(edit => edit.start < 0 || text.indexOf(edit.oldText, edit.start + 1) >= 0)) return text;
  matches.sort((a, b) => b.start - a.start);
  if (matches.some((edit, i) => i > 0 && edit.start + edit.oldText.length > matches[i - 1]!.start)) return text;
  for (const edit of matches) text = text.slice(0, edit.start) + edit.newText + text.slice(edit.start + edit.oldText.length);
  return text;
}
