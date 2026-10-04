import { createJsonRpcServer } from './jsonrpc.js';

interface Position { character: number; line: number }
interface ContentChange { range?: { end: Position; start: Position }; text?: string }
interface FixtureParams extends Record<string, unknown> {
  arguments?: unknown[];
  command?: string;
  contentChanges?: ContentChange[];
  data?: Record<string, unknown>;
  item?: { uri?: string; name?: string; data?: { uri?: string; name?: string; position?: number } };
  newName?: string;
  position?: Position;
  positions?: Position[];
  range?: unknown;
  target?: unknown;
  textDocument?: { text?: string; uri?: string; version?: number };
}

const files = new Map<string, { text: string; version: number }>();

const positionToOffset = (text: string, position?: Position): number => {
  const targetLine = Math.max(0, position?.line ?? 0);
  const targetCharacter = Math.max(0, position?.character ?? 0);
  let offset = 0;
  let line = 0;
  while (line < targetLine && offset < text.length) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
    line += 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const max = lineEnd < 0 ? text.length : lineEnd;
  return Math.min(offset + targetCharacter, max);
};

const applyContentChanges = (content: string, changes: ContentChange[]): string => {
  let next = content;
  for (const change of changes) {
    if (!change?.range) {
      next = typeof change?.text === 'string' ? change.text : next;
      continue;
    }
    const from = positionToOffset(next, change.range.start);
    const to = positionToOffset(next, change.range.end);
    next = `${next.slice(0, from)}${typeof change.text === 'string' ? change.text : ''}${next.slice(to)}`;
  }
  return next;
};

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/;

const identifierAt = (text: string, offset: number): { name: string; start: number } | null => {
  let start = Math.max(0, Math.min(offset, text.length));
  let end = start;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1]!)) start -= 1;
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end]!)) end += 1;
  const name = text.slice(start, end);
  return IDENTIFIER_RE.test(name) ? { name, start } : null;
};

const offsetToPosition = (text: string, offset: number): Position => {
  const capped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < capped; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: capped - lineStart };
};

const identifierSites = (text: string, name: string, followedByParen: boolean): Array<{ start: number; end: number }> => {
  const sites: Array<{ start: number; end: number }> = [];
  const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = match.index + match[0].length;
    if (followedByParen && !/^\s*\(/.test(text.slice(end))) continue;
    sites.push({ start: match.index, end });
  }
  return sites;
};

const siteRange = (text: string, site: { start: number; end: number }) => ({
  start: offsetToPosition(text, site.start),
  end: offsetToPosition(text, site.end),
});

/**
 * `callee(` sites in a text — the fixture's stand-in for calls the queried item
 * makes. Sites of the item's own name are excluded: `function foo(` is its
 * declaration, and calls back into it are not outgoing.
 */
const callSitesIn = (text: string, excludeName: string): Array<{ name: string; start: number; end: number }> => {
  const sites: Array<{ name: string; start: number; end: number }> = [];
  const pattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[1] === excludeName) continue;
    sites.push({ name: match[1]!, start: match.index, end: match.index + match[1]!.length });
  }
  return sites;
};

const publish = (server: { notify(method: string, params: unknown): void }, uri: string, version: number, text: string): void => {
  const diagnostics: Array<Record<string, unknown>> = [];
  if (text.includes('FIXTURE_ERROR')) {
    diagnostics.push({
      range: { start: offsetToPosition(text, text.indexOf('FIXTURE_ERROR')), end: offsetToPosition(text, text.indexOf('FIXTURE_ERROR') + 1) },
      severity: 1,
      message: 'fixture error',
    });
  }
  server.notify('textDocument/publishDiagnostics', { uri, version, diagnostics });
};

const server = createJsonRpcServer({
  input: process.stdin,
  output: process.stdout,
  async onRequest(method, rawParams) {
    const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams : {}) as FixtureParams;
    if (method === 'initialize') {
      if (process.env.VARIN_LSP_FIXTURE_MINIMAL === '1') {
        return {
          capabilities: {
            textDocumentSync: 2,
            completionProvider: {},
          },
        };
      }
      return {
        capabilities: {
          textDocumentSync: 2,
          completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
          hoverProvider: true,
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
          definitionProvider: true,
          referencesProvider: true,
          callHierarchyProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          renameProvider: true,
          codeActionProvider: { resolveProvider: true },
          executeCommandProvider: { commands: ['fixture.finish'] },
          documentFormattingProvider: true,
          documentRangeFormattingProvider: true,
          documentOnTypeFormattingProvider: { firstTriggerCharacter: '}', moreTriggerCharacter: [';'] },
          semanticTokensProvider: {
            legend: { tokenTypes: ['variable'], tokenModifiers: ['readonly'] },
            full: true,
            range: true,
          },
          inlayHintProvider: { resolveProvider: true },
          documentHighlightProvider: true,
          foldingRangeProvider: true,
          selectionRangeProvider: true,
          documentLinkProvider: { resolveProvider: true },
          colorProvider: true,
        },
      };
    }
    if (method === 'shutdown') return null;
    if (method === 'textDocument/completion') {
      return { items: [{
        label: 'fixtureItem',
        kind: 3,
        detail: 'fixture',
        documentation: { kind: 'markdown', value: '**fixture completion**' },
        insertText: 'fixtureItem(${1:value})',
        insertTextFormat: 2,
        textEdit: {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          newText: 'fixtureItem(${1:value})',
        },
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: 'import { fixtureItem } from "fixture";\n',
        }],
        data: { fixture: 'completion' },
      }] };
    }
    if (method === 'completionItem/resolve') {
      return { ...params, detail: 'resolved fixture', documentation: { kind: 'markdown', value: '**resolved**' } };
    }
    if (method === 'textDocument/hover') {
      const uri = params.textDocument?.uri ?? '';
      const text = files.get(uri)?.text ?? '';
      if (text.includes('FIXTURE_HOVER_FAIL')) {
        throw new Error('fixture hover failed');
      }
      return { contents: { kind: 'markdown', value: 'fixture-hover' } };
    }
    if (method === 'textDocument/signatureHelp') {
      return {
        signatures: [{
          label: 'fixtureItem(value: string): void',
          documentation: { kind: 'markdown', value: 'Fixture signature' },
          parameters: [{ label: [12, 25], documentation: 'Fixture value' }],
        }],
        activeSignature: 0,
        activeParameter: 0,
      };
    }
    if (method === 'textDocument/definition') {
      const uri = params?.textDocument?.uri;
      return uri ? [{
        targetUri: uri,
        targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        originSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      }] : [];
    }
    if (method === 'textDocument/references') {
      const uri = params?.textDocument?.uri;
      if (!uri) return [];
      const text = files.get(uri)?.text ?? '';
      const offset = positionToOffset(text, params.position);
      const identifier = identifierAt(text, offset);
      if (!identifier) return [];
      // Content-driven: every identifier occurrence across synced documents is
      // a reference site — a deterministic stand-in for real resolution.
      const locations: unknown[] = [];
      for (const [siteUri, file] of files) {
        for (const site of identifierSites(file.text, identifier.name, false)) {
          locations.push({ uri: siteUri, range: siteRange(file.text, site) });
        }
      }
      return locations;
    }
    if (method === 'textDocument/prepareCallHierarchy') {
      const uri = params?.textDocument?.uri;
      if (!uri) return null;
      const text = files.get(uri)?.text ?? '';
      const offset = positionToOffset(text, params.position);
      const identifier = identifierAt(text, offset);
      if (!identifier) return null;
      return [{
        name: identifier.name,
        kind: 12,
        uri,
        range: siteRange(text, { start: identifier.start, end: identifier.start + identifier.name.length }),
        selectionRange: siteRange(text, { start: identifier.start, end: identifier.start + identifier.name.length }),
        data: { uri, name: identifier.name, position: identifier.start },
      }];
    }
    if (method === 'callHierarchy/incomingCalls' || method === 'callHierarchy/outgoingCalls') {
      const item = params.item;
      const itemUri = item?.data?.uri ?? item?.uri ?? '';
      const name = item?.data?.name ?? item?.name ?? '';
      const ownStart = typeof item?.data?.position === 'number' ? item.data.position : -1;
      if (!itemUri || !name) return [];
      if (method === 'callHierarchy/incomingCalls') {
        const calls: unknown[] = [];
        for (const [siteUri, file] of files) {
          for (const site of identifierSites(file.text, name, true)) {
            // The item's own declaration is not a call into it.
            if (siteUri === itemUri && site.start === ownStart) continue;
            calls.push({
              from: {
                name: 'fixtureCaller',
                kind: 12,
                uri: siteUri,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
                selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
                data: { uri: siteUri, name: 'fixtureCaller', position: 0 },
              },
              fromRanges: [siteRange(file.text, site)],
            });
          }
        }
        return calls;
      }
      const text = files.get(itemUri)?.text ?? '';
      const calls: unknown[] = [];
      for (const site of callSitesIn(text, name)) {
        calls.push({
          to: {
            name: site.name,
            kind: 12,
            uri: itemUri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
            selectionRange: siteRange(text, site),
            data: { uri: itemUri, name: site.name, position: site.start },
          },
          fromRanges: [siteRange(text, site)],
        });
      }
      return calls;
    }
    if (method === 'textDocument/documentSymbol') {
      return [{
        name: 'fixtureSymbol',
        detail: 'fixture container',
        kind: 13,
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        children: [{
          name: 'fixtureChild',
          kind: 12,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
          selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        }],
      }];
    }
    if (method === 'workspace/symbol') {
      const uri = [...files.keys()][0];
      if (!uri) return [];
      return [{ name: 'fixtureWorkspaceSymbol', kind: 12, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } } }];
    }
    if (method === 'textDocument/rename') {
      const uri = params?.textDocument?.uri;
      return uri ? { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: params?.newName ?? 'renamed' }] } } : { changes: {} };
    }
    if (method === 'textDocument/codeAction') {
      const uri = params?.textDocument?.uri;
      return [{
        title: 'Fixture action',
        kind: 'quickfix',
        isPreferred: true,
        edit: uri ? { changes: { [uri]: [{ range: params.range, newText: 'fixed' }] } } : undefined,
        data: { fixture: 'action' },
      }];
    }
    if (method === 'codeAction/resolve') {
      return { ...params, command: { title: 'Finish fixture action', command: 'fixture.finish', arguments: ['done'] } };
    }
    if (method === 'workspace/executeCommand') {
      if (params?.command !== 'fixture.finish') throw new Error('unsupported fixture command');
      return { finished: params?.arguments?.[0] ?? null };
    }
    if (
      method === 'textDocument/formatting'
      || method === 'textDocument/rangeFormatting'
      || method === 'textDocument/onTypeFormatting'
    ) {
      return [{
        range: params?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'formatted',
      }];
    }
    if (method === 'textDocument/semanticTokens/full' || method === 'textDocument/semanticTokens/range') {
      return { resultId: 'fixture-semantic-1', data: [0, 0, 7, 0, 1] };
    }
    if (method === 'textDocument/inlayHint') {
      return [{ position: { line: 0, character: 7 }, label: ': string', kind: 1, data: { fixture: 'hint' } }];
    }
    if (method === 'inlayHint/resolve') {
      return { ...params, tooltip: { kind: 'markdown', value: 'Resolved fixture hint' }, paddingLeft: true };
    }
    if (method === 'textDocument/documentHighlight') {
      return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, kind: 2 }];
    }
    if (method === 'textDocument/foldingRange') {
      return [{ startLine: 0, endLine: 2, kind: 'region' }];
    }
    if (method === 'textDocument/selectionRange') {
      return (params?.positions ?? []).map((position) => ({
        range: { start: position, end: { line: position.line, character: position.character + 1 } },
        parent: { range: { start: { line: position.line, character: 0 }, end: { line: position.line, character: 8 } } },
      }));
    }
    if (method === 'textDocument/documentLink') {
      return [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        tooltip: 'Fixture link',
        data: { fixture: 'link' },
      }];
    }
    if (method === 'documentLink/resolve') {
      return { ...params, target: params?.data?.uri ?? params?.target ?? 'https://example.com/fixture' };
    }
    if (method === 'textDocument/documentColor') {
      return [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        color: { red: 1, green: 0.5, blue: 0, alpha: 1 },
      }];
    }
    if (method === 'textDocument/colorPresentation') {
      return [{ label: '#ff8000', textEdit: { range: params.range, newText: '#ff8000' } }];
    }
    return null;
  },
  onNotification(method, rawParams) {
    const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams : {}) as FixtureParams;
    if (method === 'initialized' && process.env.VARIN_LSP_FIXTURE_CRASH === '1') {
      process.exit(17);
      return;
    }
    if (method === 'exit') {
      process.exit(0);
      return;
    }
    if (method === 'textDocument/didOpen') {
      const uri = params.textDocument?.uri ?? '';
      const text = params?.textDocument?.text ?? '';
      const version = params?.textDocument?.version ?? 0;
      files.set(uri, { text, version });
      publish(server, uri, text.includes('FIXTURE_STALE_DIAG') ? 0 : version, text);
      return;
    }
    if (method === 'textDocument/didChange') {
      const uri = params.textDocument?.uri ?? '';
      const version = params?.textDocument?.version ?? 0;
      const changes = Array.isArray(params?.contentChanges) ? params.contentChanges : [];
      const text = applyContentChanges(files.get(uri)?.text ?? '', changes);
      files.set(uri, { text, version });
      publish(server, uri, text.includes('FIXTURE_STALE_DIAG') ? 0 : version, text);
    }
    if (method === 'textDocument/didClose') {
      const uri = params.textDocument?.uri;
      if (uri) files.delete(uri);
    }
  },
});
