import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const packageDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const languageServersRoot = join(packageDirectory, 'dist', 'builtin-packages', 'language-servers');
const require = createRequire(import.meta.url);

const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

class LspClient {
  #buffer = Buffer.alloc(0);
  #stderr = '';
  #nextRequestId = 1;
  #pending = new Map();
  #notifications = [];
  #waiters = [];

  constructor(child) {
    this.child = child;
    this.closed = new Promise((resolvePromise) => child.once('close', resolvePromise));
    child.stdout.on('data', (chunk) => this.#read(chunk));
    child.stderr.on('data', (chunk) => { this.#stderr += chunk.toString(); });
    child.on('error', (error) => this.#fail(error));
    child.on('close', (code, signal) => this.#fail(new Error(`LSP server exited (${code ?? 'null'}/${signal ?? 'null'})`)));
  }

  #fail(error) {
    const failure = this.#stderr ? new Error(`${error.message}\n${this.#stderr}`) : error;
    for (const { reject } of this.#pending.values()) reject(failure);
    this.#pending.clear();
    for (const waiter of this.#waiters.splice(0)) waiter.reject(failure);
  }

  #read(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (true) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = this.#buffer.subarray(0, headerEnd).toString('ascii');
      const contentLength = Number(headers.match(/content-length:\s*(\d+)/i)?.[1] ?? NaN);
      if (!Number.isFinite(contentLength)) throw new Error(`Invalid LSP headers: ${headers}`);
      const contentStart = headerEnd + 4;
      if (this.#buffer.length < contentStart + contentLength) return;
      const message = JSON.parse(this.#buffer.subarray(contentStart, contentStart + contentLength).toString('utf8'));
      this.#buffer = this.#buffer.subarray(contentStart + contentLength);
      this.#handle(message);
    }
  }

  #handle(message) {
    if (message.method && message.id !== undefined) {
      const params = message.params;
      let result;
      switch (message.method) {
        case 'workspace/configuration':
          result = Array.isArray(params?.items) ? params.items.map(() => null) : [];
          break;
        case 'workspace/workspaceFolders':
          result = [];
          break;
        case 'client/registerCapability':
        case 'client/unregisterCapability':
        case 'window/workDoneProgress/create':
          result = null;
          break;
        case 'workspace/applyEdit':
          result = { applied: false, failureReason: 'Packaging smoke client does not apply edits' };
          break;
        default:
          this.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: `Packaging smoke does not implement ${message.method}` },
          });
          return;
      }
      this.send({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      this.#notifications.push(message);
      for (const waiter of [...this.#waiters]) {
        if (waiter.predicate(message)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method, params, timeoutMilliseconds = 15_000) {
    const id = this.#nextRequestId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMilliseconds);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  notification(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  waitForNotification(predicate, timeoutMilliseconds = 15_000) {
    const existing = this.#notifications.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolvePromise);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error('Timed out waiting for LSP notification'));
      }, timeoutMilliseconds);
      this.#waiters.push({
        predicate,
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async initialize(rootUri, initializationOptions = {}) {
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ name: 'smoke', uri: rootUri }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true } },
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true },
          synchronization: { dynamicRegistration: true },
        },
        window: { workDoneProgress: true },
      },
      initializationOptions,
      locale: 'en',
    });
    this.notification('initialized', {});
    return result;
  }

  async stop() {
    await this.request('shutdown', null, 2_000).catch(() => undefined);
    this.notification('exit', null);
    await wait(40);
    this.child.kill();
    await Promise.race([this.closed, wait(1_000)]);
  }
}

const startServer = (descriptor) => new LspClient(spawn(
  descriptor.command,
  descriptor.args,
  { cwd: descriptor.cwd, env: descriptor.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
));

const fileNameForProvider = (providerId) => ({
  'varin.python-language': 'sample.py',
  'varin.html-language': 'sample.html',
  'varin.css-language': 'sample.css',
  'varin.json-language': 'sample.json',
  'varin.yaml-language': 'sample.yaml',
  'varin.bash-language': 'sample.sh',
}[providerId]);

const documentForProvider = (providerId) => ({
  'varin.python-language': {
    languageId: 'python',
    text: 'def greet(name: str) -> str:\n    return name\n',
    method: 'textDocument/documentSymbol',
    check: (result) => { if (!result.some((symbol) => symbol.name === 'greet')) throw new Error(`python symbols: ${JSON.stringify(result)}`); },
  },
  'varin.html-language': {
    languageId: 'html',
    text: '<section><h1 id="title">Hello</h1></section>\n',
    method: 'textDocument/documentSymbol',
    check: (result) => assert.ok(result.some((symbol) => symbol.name === 'section')),
  },
  'varin.css-language': {
    languageId: 'css',
    text: '.button { color: red; }\n',
    method: 'textDocument/documentSymbol',
    check: (result) => assert.ok(result.some((symbol) => symbol.name === '.button')),
  },
  'varin.json-language': {
    languageId: 'json',
    text: '{"name":"Varin","enabled":true}\n',
    method: 'textDocument/documentSymbol',
    check: (result) => assert.ok(result.some((symbol) => symbol.name === 'name')),
  },
  'varin.yaml-language': {
    languageId: 'yaml',
    text: 'name: Varin\nenabled: true\n',
    method: 'textDocument/documentSymbol',
    check: (result) => assert.ok(result.some((symbol) => symbol.name === 'name')),
  },
  'varin.bash-language': {
    languageId: 'shellscript',
    text: 'greeting=world\necho $greeting\n',
    method: 'textDocument/hover',
    position: { line: 1, character: 8 },
    check: (result) => assert.ok(result?.contents, 'Bash hover must contain variable documentation'),
  },
}[providerId]);

test('built-in Host entrypoint registers and runs every packaged language provider from one copied package', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'varin-language-servers-'));
  const copiedRoot = join(temporaryRoot, 'language-servers');
  await cp(languageServersRoot, copiedRoot, { recursive: true });
  const rootUri = pathToFileURL(temporaryRoot).toString();
  const registrations = [];
  const effects = [];
  const hostModule = require(join(copiedRoot, 'host.cjs'));
  const candidate = hostModule.default ?? hostModule;
  const activate = typeof candidate === 'function' ? candidate : candidate.activate;
  assert.equal(typeof activate, 'function', 'packaged language Host module must export activate');
  const context = {
    assets: {
      path(logicalPath) {
        if (!logicalPath || logicalPath.includes('\\') || logicalPath.includes('..')) throw new Error(`unsafe asset ${logicalPath}`);
        return join(copiedRoot, ...logicalPath.split('/'));
      },
    },
    capabilities: {
      async call(capability, method, params) {
        assert.equal(capability, 'workspace.language');
        if (method === 'registerProvider') {
          registrations.push(params);
          return { status: 'registered' };
        }
        if (method === 'unregisterProvider') return { status: 'unregistered' };
        throw new Error(`unexpected Host capability call ${method}`);
      },
    },
    effect(disposer) { effects.push(disposer); },
    signal: new AbortController().signal,
    services: { provide() {}, use() { throw new Error('not used by language Host'); } },
    storage: {},
  };
  try {
    await access(join(copiedRoot, 'host.cjs'));
    await activate(context);
    assert.deepEqual(
      registrations.map(({ providerId }) => providerId),
      [
        'varin.python-language',
        'varin.html-language',
        'varin.css-language',
        'varin.json-language',
        'varin.yaml-language',
        'varin.bash-language',
      ],
    );
    for (const registration of registrations) {
      assert.equal(registration.command, process.execPath);
      assert.equal(registration.source, 'extension');
      assert.ok(registration.args?.length >= 2);
      assert.ok(registration.args[0].startsWith(copiedRoot));
      await access(registration.args[0]);
      const document = documentForProvider(registration.providerId);
      assert.ok(document, `missing smoke document for ${registration.providerId}`);
      const sourcePath = join(temporaryRoot, fileNameForProvider(registration.providerId));
      const uri = pathToFileURL(sourcePath).toString();
      await writeFile(sourcePath, document.text, 'utf8');
      const descriptor = {
        ...registration,
        cwd: copiedRoot,
        args: registration.args,
      };
      const server = startServer(descriptor);
      try {
        const initializationOptions = registration.initializationOptions ?? {};
        const initialized = await server.initialize(rootUri, initializationOptions);
        assert.ok(initialized?.capabilities, `${registration.providerId} did not initialize`);
        server.notification('textDocument/didOpen', {
          textDocument: { uri, languageId: document.languageId, version: 1, text: document.text },
        });
        await wait(500);
        const result = await server.request(document.method, {
          textDocument: { uri },
          ...(document.position ? { position: document.position } : {}),
        });
        if (document.method === 'textDocument/documentSymbol') {
          assert.ok(Array.isArray(result), `${registration.providerId} returned no symbol list`);
        }
        document.check(result);
      } finally {
        await server.stop();
      }
    }
    for (const disposer of effects.reverse()) await disposer();
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
  }
});

test('packaged Bash formatter preserves environment settings when initialization overrides one setting', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'varin-bash-configuration-'));
  const copiedRoot = join(temporaryRoot, 'language-servers');
  const fixturePath = join(temporaryRoot, 'formatter fixture.cjs');
  const invocationPath = join(temporaryRoot, 'formatter-invocation.json');
  const sourcePath = join(temporaryRoot, 'sample.sh');
  const uri = pathToFileURL(sourcePath).toString();
  const source = 'greeting=world\necho    "$greeting"\n';
  const formatted = 'greeting=world\necho "$greeting"\n';
  let server;
  try {
    await cp(languageServersRoot, copiedRoot, { recursive: true });
    await writeFile(sourcePath, source, 'utf8');
    await writeFile(join(temporaryRoot, '.editorconfig'), [
      'root = true',
      '[*.sh]',
      'shell_variant = bash',
      'binary_next_line = false',
      'switch_case_indent = false',
      '',
    ].join('\n'), 'utf8');
    // Node is the real spawned formatter, avoiding shfmt installation, shell wrappers,
    // executable permissions, and platform-specific quoting (including paths with spaces).
    await writeFile(fixturePath, `
      const { readFileSync, writeFileSync } = require('node:fs');
      const input = readFileSync(0, 'utf8');
      writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ args: process.argv.slice(2), input }));
      process.stdout.write(input.replace('echo    ', 'echo '));
    `, 'utf8');
    server = startServer({
      command: process.execPath,
      args: [join(copiedRoot, 'runtime', 'bash-language-server.cjs'), 'start'],
      cwd: copiedRoot,
      env: {
        ...process.env,
        BACKGROUND_ANALYSIS_MAX_FILES: '0',
        BASH_IDE_LOG_LEVEL: 'error',
        SHELLCHECK_PATH: '',
        SHFMT_PATH: process.execPath,
        SHFMT_IGNORE_EDITORCONFIG: 'true',
        SHFMT_LANGUAGE_DIALECT: 'posix',
        SHFMT_BINARY_NEXT_LINE: 'true',
        SHFMT_CASE_INDENT: '1',
        SHFMT_FUNC_NEXT_LINE: 'false',
        SHFMT_KEEP_PADDING: 'false',
        SHFMT_SIMPLIFY_CODE: 'false',
        SHFMT_SPACE_REDIRECTS: 'false',
      },
    });
    const initialized = await server.initialize(pathToFileURL(temporaryRoot).toString(), {
      // Omitted options must not acquire Zod defaults and replace the environment.
      shfmt: { additionalArguments: [fixturePath] },
    });
    assert.equal(initialized.capabilities.documentFormattingProvider, true);
    server.notification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'shellscript', version: 1, text: source },
    });
    await server.waitForNotification((message) => (
      message.method === 'textDocument/publishDiagnostics' && message.params?.uri === uri
    ));
    const edits = await server.request('textDocument/formatting', {
      textDocument: { uri },
      options: { insertSpaces: true, tabSize: 2 },
    });
    assert.equal(edits?.length, 1, 'the environment-configured formatter must run');
    assert.equal(edits[0].newText, formatted);
    const invocation = JSON.parse(await readFile(invocationPath, 'utf8'));
    assert.equal(invocation.input, source, 'the formatter must receive the opened document');
    assert.deepEqual(
      invocation.args.filter((argument) => !argument.startsWith('--filename=')),
      ['-i=2', '-bn', '-ci', '-ln=posix', '-'],
      'environment flags must survive the partial initialization options and conflicting .editorconfig',
    );
  } finally {
    if (server) await server.stop();
    await rm(temporaryRoot, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
  }
});
