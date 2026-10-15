import { describe, expect, test, vi } from 'vitest';
import type { editor, languages } from 'monaco-editor/editor';

import type { LanguageServicesAPI, VarinLanguageDiagnostic } from '@varin/application-client';
import type { DocumentRegistry } from '@/lib/documents/registry';
import type { DocumentIdentity, DocumentRecord, DocumentWorkspaceEditInput } from '@/lib/documents/types';
import { MonacoLanguageBridge } from './language-bridge';
import type { FileEditorModelRegistry } from './model-registry';
import type { MonacoRuntime } from './runtime';

const identity: DocumentIdentity = {
  workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceId: 'src/file.ts',
};

const record = (): DocumentRecord => ({
  identity,
  documentInstanceId: 'document-one',
  connectionGeneration: 1,
  workspaceEpoch: 1,
  status: 'ready',
  dirty: true,
  saving: false,
  baseContent: '',
  buffer: 'doc',
  baseRevision: 'disk-one',
  localEditRevision: 3,
  encoding: 'utf-8',
  bom: false,
  lineEnding: 'lf',
  byteLength: 3,
  saveOperationId: null,
  saveCapturedEditRevision: null,
  conflict: null,
  errorMessage: null,
  recoveryJournalId: null,
  recoveryJournalRevision: null,
  lastOrigin: null,
  lastChanges: null,
  externalSource: null,
});

describe('MonacoLanguageBridge', () => {
  test('projects markers and baseline providers while rejecting stale feature completion', async () => {
    let current = record();
    let completionProvider: languages.CompletionItemProvider | undefined;
    let hoverProvider: languages.HoverProvider | undefined;
    let renameProvider: languages.RenameProvider | undefined;
    let documentListener: ((record: DocumentRecord) => void) | undefined;
    let diagnosticsListener: (() => void) | undefined;
    const markers: Array<{ owner: string; items: editor.IMarkerData[] }> = [];
    const providerDispose = vi.fn();
    const model = {
      getWordUntilPosition: () => ({ word: 'doc', startColumn: 1, endColumn: 4 }),
      validateRange: (range: unknown) => range,
    } as unknown as editor.ITextModel;
    const monaco = {
      MarkerTag: { Unnecessary: 1, Deprecated: 2 },
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      Uri: { from: (value: Record<string, string>) => ({ ...value, toString: () => `${value.scheme}://${value.authority}${value.path}` }) },
      editor: {
        registerCommand: () => ({ dispose: providerDispose }),
        registerEditorOpener: () => ({ dispose: providerDispose }),
        registerLinkOpener: () => ({ dispose: providerDispose }),
        setModelLanguage: vi.fn(),
        setModelMarkers: (_model: editor.ITextModel, owner: string, items: editor.IMarkerData[]) => markers.push({ owner, items }),
      },
      languages: {
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        CompletionItemKind: new Proxy({ Text: 18 }, { get: (target, key) => Reflect.get(target, key) ?? 18 }),
        CompletionItemTag: { Deprecated: 1 },
        CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
        DocumentHighlightKind: { Text: 0, Read: 1, Write: 2 },
        FoldingRangeKind: { Comment: { value: 'comment' }, Imports: { value: 'imports' }, Region: { value: 'region' } },
        InlayHintKind: { Type: 1, Parameter: 2 },
        SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 },
        SymbolKind: new Proxy({ Variable: 12 }, { get: (target, key) => Reflect.get(target, key) ?? 12 }),
        SymbolTag: { Deprecated: 1 },
        getLanguages: () => [],
        register: () => ({ dispose: providerDispose }),
        registerCompletionItemProvider: (_languageId: string, provider: languages.CompletionItemProvider) => {
          completionProvider = provider;
          return { dispose: providerDispose };
        },
        registerHoverProvider: (_languageId: string, provider: languages.HoverProvider) => {
          hoverProvider = provider;
          return { dispose: providerDispose };
        },
        registerSignatureHelpProvider: () => ({ dispose: providerDispose }),
        registerDefinitionProvider: () => ({ dispose: providerDispose }),
        registerReferenceProvider: () => ({ dispose: providerDispose }),
        registerRenameProvider: (_languageId: string, provider: languages.RenameProvider) => {
          renameProvider = provider;
          return { dispose: providerDispose };
        },
        registerCodeActionProvider: () => ({ dispose: providerDispose }),
        registerDocumentSymbolProvider: () => ({ dispose: providerDispose }),
        registerDocumentHighlightProvider: () => ({ dispose: providerDispose }),
        registerDocumentFormattingEditProvider: () => ({ dispose: providerDispose }),
        registerDocumentRangeFormattingEditProvider: () => ({ dispose: providerDispose }),
        registerOnTypeFormattingEditProvider: () => ({ dispose: providerDispose }),
        registerFoldingRangeProvider: () => ({ dispose: providerDispose }),
        registerSelectionRangeProvider: () => ({ dispose: providerDispose }),
        registerDocumentSemanticTokensProvider: () => ({ dispose: providerDispose }),
        registerInlayHintsProvider: () => ({ dispose: providerDispose }),
        registerLinkProvider: () => ({ dispose: providerDispose }),
        registerColorProvider: () => ({ dispose: providerDispose }),
      },
    } as unknown as MonacoRuntime;
    const diagnostic: VarinLanguageDiagnostic = {
      resource: identity,
      documentVersion: 3,
      severity: 'warning',
      message: 'Check this value',
      providerId: 'fixture',
      generation: 2,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
    };
    let diagnostics = [diagnostic];
    const completion = vi.fn(async () => ({
      status: 'ready' as const,
      documentVersion: 3,
      providerId: 'fixture',
      generation: 2,
      value: [{
        label: 'document',
        insertText: 'document',
        detail: 'global',
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: 'import "document";\n',
        }],
      }],
    }));
    const hover = vi.fn(async () => ({
      status: 'ready' as const,
      documentVersion: 3,
      providerId: 'fixture',
      generation: 2,
      value: { contents: [{ kind: 'markdown' as const, value: '`Document`' }] },
    }));
    const rename = vi.fn(async () => ({
      status: 'ready' as const,
      documentVersion: 3,
      providerId: 'fixture',
      generation: 2,
      value: {
        documentChanges: [{
          kind: 'text' as const,
          resource: identity,
          version: 3,
          edits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: 'document',
          }],
        }],
      },
    }));
    const language = { completion, hover, rename } as unknown as LanguageServicesAPI;
    const prepareWorkspaceEdit = vi.fn(async (input: DocumentWorkspaceEditInput) => ({
      status: 'ready' as const,
      groupId: 'rename-group',
      workspaceId: identity.workspaceId,
      origin: input.origin,
      files: [{ identity, beforeContent: 'doc', afterContent: 'document', editCount: 1 }],
      requiresConfirmation: false,
    }));
    const applyWorkspaceEdit = vi.fn(async () => ({
      status: 'applied' as const,
      groupId: 'rename-group',
      records: [current],
    }));
    const documentRegistry = {
      prepareWorkspaceEdit,
      applyWorkspaceEdit,
      discardWorkspaceEdit: vi.fn(),
      undoWorkspaceEdit: vi.fn(),
    } as unknown as DocumentRegistry;
    const acquireDocument = vi.fn();
    const releaseDocument = vi.fn();
    const notifyDocumentChange = vi.fn();
    const notifyDocumentSave = vi.fn();
    const bridge = new MonacoLanguageBridge({
      monaco,
      modelRegistry: {
        getRecordForModel: () => current,
      } as unknown as FileEditorModelRegistry,
      acquireDocument,
      releaseDocument,
      notifyDocumentChange,
      notifyDocumentSave,
      getLanguage: () => language,
      getDocumentRegistry: () => documentRegistry,
      diagnosticsFor: () => diagnostics,
      subscribeDiagnostics: (listener) => {
        diagnosticsListener = listener;
        return () => { diagnosticsListener = undefined; };
      },
      subscribeProviderStatus: () => () => undefined,
      subscribeDocument: (_resource, listener) => {
        documentListener = listener;
        return () => { documentListener = undefined; };
      },
    });

    bridge.acquire(model, identity, 'view:one');
    expect(acquireDocument).toHaveBeenCalledWith(identity, 'typescript');
    expect(markers.at(-1)?.items[0]).toMatchObject({
      message: 'Check this value',
      severity: 4,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    });
    if (!completionProvider?.provideCompletionItems || !hoverProvider?.provideHover || !renameProvider?.provideRenameEdits) {
      throw new Error('expected Monaco providers');
    }
    const token = { isCancellationRequested: false } as never;
    const completionResult = await completionProvider.provideCompletionItems(
      model,
      { lineNumber: 1, column: 4 } as never,
      {} as languages.CompletionContext,
      token,
    );
    expect(completionResult?.suggestions[0]).toMatchObject({
      label: 'document',
      insertText: 'document',
      range: { startColumn: 1, endColumn: 4 },
      additionalTextEdits: [{ text: 'import "document";\n' }],
    });
    expect(await hoverProvider.provideHover(model, { lineNumber: 1, column: 2 } as never, token)).toMatchObject({
      contents: [{ value: '`Document`' }],
    });
    expect(await renameProvider.provideRenameEdits(
      model,
      { lineNumber: 1, column: 2 } as never,
      'document',
      token,
    )).toEqual({ edits: [] });
    expect(rename).toHaveBeenCalledWith(expect.objectContaining({
      resource: identity,
      documentVersion: 3,
      position: { line: 0, character: 1 },
      newName: 'document',
    }));
    expect(prepareWorkspaceEdit).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: identity.workspaceId,
      origin: 'language:rename:fixture:2',
    }));
    expect(applyWorkspaceEdit).toHaveBeenCalledWith('rename-group');

    current = { ...current, localEditRevision: 4 };
    expect((await completionProvider.provideCompletionItems(
      model,
      { lineNumber: 1, column: 4 } as never,
      {} as languages.CompletionContext,
      token,
    ))?.suggestions).toEqual([]);
    documentListener?.(current);
    expect(notifyDocumentChange).toHaveBeenCalledWith(identity);
    current = { ...current, saving: true };
    documentListener?.(current);
    current = { ...current, saving: false, baseRevision: 'disk-two' };
    documentListener?.(current);
    expect(notifyDocumentSave).toHaveBeenCalledWith(identity);
    diagnostics = [{ ...diagnostic, generation: 3, message: 'New generation' }];
    diagnosticsListener?.();
    expect(markers).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: 'varin-language:fixture:2', items: [] }),
      expect.objectContaining({
        owner: 'varin-language:fixture:3',
        items: [expect.objectContaining({ message: 'New generation' })],
      }),
    ]));

    bridge.release('view:one');
    expect(releaseDocument).toHaveBeenCalledWith(identity);
    expect(markers.at(-1)).toMatchObject({ owner: 'varin-language:fixture:3', items: [] });
    expect(providerDispose).toHaveBeenCalled();
    bridge.dispose();
  });
  test.each(['rename', 'delete'] as const)('runs the original code-action command after its %s edit', async kind => {
    let current = record();
    let listener: ((record: DocumentRecord) => void) | undefined;
    let codeActions: languages.CodeActionProvider | undefined;
    let runCommand: ((_accessor: unknown, id: unknown) => void) | undefined;
    const moved = { ...identity, resourceId: 'src/moved.ts' };
    const model = {} as editor.ITextModel;
    const acquireDocument = vi.fn(); const releaseDocument = vi.fn();
    const monaco = {
      editor: { registerCommand: (_id: string, handler: typeof runCommand) => { runCommand = handler; return { dispose() {} }; },
        registerEditorOpener: () => ({ dispose() {} }), registerLinkOpener: () => ({ dispose() {} }),
        setModelLanguage: vi.fn(), setModelMarkers: vi.fn() },
      languages: new Proxy({ getLanguages: () => [], registerCodeActionProvider: (_id: string, provider: languages.CodeActionProvider) => {
        codeActions = provider; return { dispose() {} };
      } }, { get: (target, key) => Reflect.get(target, key) ?? (() => ({ dispose() {} })) }),
    } as unknown as MonacoRuntime;
    const executeCommand = vi.fn(async (_request: Parameters<LanguageServicesAPI['executeCommand']>[0]) => ({ status: 'ready', providerId: 'fixture', generation: 2, documentVersion: 3, value: null }));
    const language = { executeCommand, codeActions: async () => ({ status: 'ready', providerId: 'fixture', generation: 2, documentVersion: 3,
      value: [{ title: 'Refactor file', edit: { documentChanges: [kind === 'rename'
        ? { kind, from: identity, to: moved } : { kind, resource: identity }] }, command: { title: 'Finish', command: 'fixture.finish', arguments: ['done'] } }] }) } as unknown as LanguageServicesAPI;
    const applyWorkspaceEdit = vi.fn(async () => {
      current = kind === 'rename' ? { ...current, identity: moved } : { ...current, status: 'deleted', baseRevision: null, localEditRevision: 4 };
      listener?.(current); return { status: 'applied', groupId: 'refactor', records: [current] };
    });
    const registry = { getByDocumentInstance: (id: string) => current.documentInstanceId === id ? current : undefined,
      prepareWorkspaceEdit: async () => ({ status: 'ready', groupId: 'refactor', workspaceId: identity.workspaceId, origin: 'test', requiresConfirmation: false,
        files: [{ identity, beforeContent: 'doc', afterContent: 'doc', editCount: 0, kind }] }), applyWorkspaceEdit,
      discardWorkspaceEdit: vi.fn(), undoWorkspaceEdit: vi.fn() } as unknown as DocumentRegistry;
    const bridge = new MonacoLanguageBridge({ monaco, modelRegistry: { getRecordForModel: () => current } as unknown as FileEditorModelRegistry,
      acquireDocument, releaseDocument, notifyDocumentChange: vi.fn(), notifyDocumentSave: vi.fn(), getLanguage: () => language,
      getDocumentRegistry: () => registry, diagnosticsFor: () => [], subscribeDiagnostics: () => () => undefined,
      subscribeProviderStatus: () => () => undefined, subscribeDocument: (_resource, callback) => { listener = callback; return () => undefined; } });
    bridge.acquire(model, identity, 'view');
    const actions = await codeActions!.provideCodeActions(model, { startLineNumber: 1, endLineNumber: 1, startColumn: 1, endColumn: 2 } as never,
      { markers: [] } as never, { isCancellationRequested: false } as never);
    const invocation = actions!.actions[0]!.command!.arguments![0]; runCommand!(null, invocation);
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1));
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({ resource: kind === 'rename' ? moved : identity,
      providerId: 'fixture', generation: 2, languageId: 'typescript', command: 'fixture.finish', arguments: ['done'] }));
    if (kind === 'delete') {
      expect(executeCommand.mock.calls[0]![0]).not.toHaveProperty('documentVersion');
      expect(releaseDocument).toHaveBeenCalledWith(identity);
    }
    runCommand!(null, invocation); await Promise.resolve(); expect(applyWorkspaceEdit).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledTimes(1); bridge.dispose();
  });

});
