import { resolveNodeRuntime } from '@varin/protocol/node/runtime';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createDapServer } from './dap.js';

const INSPECTOR_URL = /ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[0-9a-f-]+/i;

type MessageRecord = Record<string, unknown>;
type CdpEventListener = (method: string, params: MessageRecord) => void;

interface CdpWaiter {
  reject(error: unknown): void;
  resolve(value: MessageRecord): void;
}

interface CdpClient {
  readonly ready: Promise<void>;
  close(): void;
  onEvent(listener: CdpEventListener): () => boolean;
  request(method: string, params?: MessageRecord): Promise<MessageRecord>;
}

interface CdpLocation {
  columnNumber?: number;
  lineNumber?: number;
}

interface CdpRemoteObject {
  description?: string;
  objectId?: string;
  type?: string;
  value?: unknown;
}

interface CdpScope {
  object?: CdpRemoteObject;
  type?: string;
}

interface CdpCallFrame {
  callFrameId?: string;
  functionName?: string;
  location?: CdpLocation;
  scopeChain?: CdpScope[];
  url?: string;
}

interface CdpPausedEvent {
  callFrames?: CdpCallFrame[];
  reason?: string;
}

interface CdpProperty {
  name?: string;
  value?: CdpRemoteObject;
}

const asRecord = (value: unknown): MessageRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as MessageRecord
    : {}
);

const waitForInspectorUrl = (child: ChildProcess, timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error('Node inspector did not start'));
  }, timeoutMs);
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const match = buffer.match(INSPECTOR_URL);
    if (!match) return;
    cleanup();
    resolve(match[0]);
  };
  const onExit = () => {
    cleanup();
    reject(new Error('Node debuggee exited before the inspector was ready'));
  };
  const cleanup = () => {
    clearTimeout(timer);
    child.stderr?.off('data', onData);
    child.off('exit', onExit);
  };
  child.stderr?.on('data', onData);
  child.once('exit', onExit);
});

const createCdp = (url: string): CdpClient => {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map<number, CdpWaiter>();
  const listeners = new Set<CdpEventListener>();
  const onMessage = (event: { data: unknown }) => {
    let message: MessageRecord;
    try {
      message = asRecord(JSON.parse(String(event.data)));
    } catch {
      return;
    }
    if (typeof message.id === 'number' && pending.has(message.id)) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (!waiter) return;
      const failure = asRecord(message.error);
      if (message.error) waiter.reject(new Error(typeof failure.message === 'string' ? failure.message : 'Inspector request failed'));
      else waiter.resolve(asRecord(message.result));
      return;
    }
    if (message && typeof message.method === 'string') {
      for (const listener of listeners) listener(message.method, asRecord(message.params));
    }
  };
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Inspector websocket timed out')), 8000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Inspector websocket failed'));
    }, { once: true });
  });
  ws.addEventListener('message', onMessage);
  return {
    ready,
    request(method: string, params?: MessageRecord): Promise<MessageRecord> {
      const id = nextId;
      nextId += 1;
      return new Promise<MessageRecord>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const payload = params === undefined ? { id, method } : { id, method, params };
        ws.send(JSON.stringify(payload));
      });
    },
    onEvent(listener: CdpEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      for (const waiter of pending.values()) waiter.reject(new Error('Inspector closed'));
      pending.clear();
      listeners.clear();
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    },
  };
};

const relativeFromRoot = (root: string, absolutePath: string): string | null => {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
};

let child: ChildProcess | null = null;
let cdp: CdpClient | null = null;
let cwd = process.cwd();
let program = '';
let pausedEvent: CdpPausedEvent | null = null;
let objectIdByRef = new Map<number, string>();
let nextVarRef = 2;
const requestedBreakpoints = new Map<string, MessageRecord[]>();
let configurationDoneRequested = false;

const resetVariableRefs = () => {
  objectIdByRef = new Map();
  nextVarRef = 2;
};

const refForObject = (objectId: string): number => {
  const existing = [...objectIdByRef.entries()].find((entry) => entry[1] === objectId);
  if (existing) return existing[0];
  const ref = nextVarRef;
  nextVarRef += 1;
  objectIdByRef.set(ref, objectId);
  return ref;
};

const sourceFromCallFrame = (frame: CdpCallFrame): { path: string } => {
  const url = typeof frame?.url === 'string' ? frame.url : '';
  if (!url.startsWith('file:')) return { path: program || 'debuggee.js' };
  try {
    const absolute = fileURLToPath(url);
    const resourceId = relativeFromRoot(cwd, absolute);
    return { path: resourceId ?? absolute };
  } catch {
    return { path: program || 'debuggee.js' };
  }
};

const applyBreakpoints = async (sourcePath: string, requested: MessageRecord[]) => {
  const url = sourcePath.startsWith('file:') ? sourcePath : pathToFileURL(sourcePath).href;
  const breakpoints = [];
  for (const item of requested) {
    const line = Number(item?.line);
    if (!Number.isFinite(line) || line < 1 || !cdp) {
      breakpoints.push({ line, verified: false });
      continue;
    }
    try {
      await cdp.request('Debugger.setBreakpointByUrl', {
        url,
        lineNumber: line - 1,
        columnNumber: 0,
      });
      breakpoints.push({ line, verified: true });
    } catch {
      breakpoints.push({ line, verified: false });
    }
  }
  return breakpoints;
};

const server = createDapServer({
  input: process.stdin,
  output: process.stdout,
  async onRequest(method, params) {
    const request = asRecord(params);
    if (method === 'initialize') {
      return {
        supportsConfigurationDoneRequest: true,
        supportsEvaluateForHovers: true,
      };
    }
    if (method === 'launch') {
      program = typeof request.program === 'string' ? request.program : '';
      cwd = typeof request.cwd === 'string' ? request.cwd : path.dirname(program);
      child = spawn(resolveNodeRuntime().executable, ['--inspect-brk=127.0.0.1:0', program], {
        cwd,
        env: { ...resolveNodeRuntime().env, NODE_OPTIONS: '' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (chunk) => {
        server.notify('output', { category: 'stdout', output: chunk.toString('utf8') });
      });
      const inspectorUrl = await waitForInspectorUrl(child, 8000);
      cdp = createCdp(inspectorUrl);
      await cdp.ready;
      cdp.onEvent((eventMethod, eventParams) => {
        if (eventMethod === 'Debugger.paused') {
          pausedEvent = eventParams as CdpPausedEvent;
          server.notify('stopped', {
            reason: eventParams?.reason === 'other' ? 'breakpoint' : (eventParams?.reason || 'pause'),
            threadId: 1,
            allThreadsStopped: true,
          });
        }
        if (eventMethod === 'Debugger.resumed') {
          pausedEvent = null;
          server.notify('continued', { threadId: 1, allThreadsContinued: true });
        }
        if (eventMethod === 'Runtime.consoleAPICalled') {
          const text = Array.isArray(eventParams.args)
            ? eventParams.args.map((arg) => {
              const value = asRecord(arg);
              return value.value ?? value.description ?? '';
            }).join(' ')
            : '';
          if (text) server.notify('output', { category: 'console', output: `${text}\n` });
        }
      });
      child.on('exit', (code) => {
        server.notify('exited', { exitCode: code ?? 0 });
        server.notify('terminated', {});
      });
      await cdp.request('Debugger.enable');
      await cdp.request('Runtime.enable');
      for (const [sourcePath, requested] of requestedBreakpoints) {
        await applyBreakpoints(sourcePath, requested);
      }
      if (configurationDoneRequested) await cdp.request('Runtime.runIfWaitingForDebugger');
      return {};
    }
    if (method === 'setBreakpoints') {
      const source = asRecord(request.source);
      const sourcePath = typeof source.path === 'string' ? source.path : program;
      const requested = Array.isArray(request.breakpoints) ? request.breakpoints.map(asRecord) : [];
      requestedBreakpoints.set(sourcePath, requested);
      const breakpoints = await applyBreakpoints(sourcePath, requested);
      return { breakpoints };
    }
    if (method === 'configurationDone') {
      configurationDoneRequested = true;
      if (cdp) await cdp.request('Runtime.runIfWaitingForDebugger');
      return {};
    }
    if (method === 'threads') return { threads: [{ id: 1, name: 'node' }] };
    if (method === 'stackTrace') {
      const frames = Array.isArray(pausedEvent?.callFrames) ? pausedEvent.callFrames : [];
      return {
        stackFrames: frames.map((frame, index) => ({
          id: index + 1,
          name: frame.functionName || '(anonymous)',
          line: (frame.location?.lineNumber ?? 0) + 1,
          column: (frame.location?.columnNumber ?? 0) + 1,
          source: sourceFromCallFrame(frame),
        })),
        totalFrames: frames.length,
      };
    }
    if (method === 'scopes') {
      resetVariableRefs();
      const frameIndex = Math.max(0, Number(request.frameId ?? 1) - 1);
      const frame = pausedEvent?.callFrames?.[frameIndex];
      const chain = Array.isArray(frame?.scopeChain) ? frame.scopeChain : [];
      return {
        scopes: chain.map((scope) => {
          const objectId = scope?.object?.objectId;
          const mapped = {
            name: scope?.type || 'scope',
            expensive: false,
            variablesReference: objectId ? refForObject(objectId) : 0,
          };
          return mapped;
        }),
      };
    }
    if (method === 'variables') {
      const objectId = objectIdByRef.get(Number(request.variablesReference));
      if (!objectId || !cdp) return { variables: [] };
      const result = await cdp.request('Runtime.getProperties', {
        objectId,
        ownProperties: true,
        generatePreview: true,
      });
      const properties = Array.isArray(result.result) ? result.result as CdpProperty[] : [];
      return {
        variables: properties
          .filter((item): item is CdpProperty & { name: string } => typeof item.name === 'string' && !item.name.startsWith('__'))
          .map((item) => {
          const nestedId = item.value?.objectId;
          const mapped: { name: string; type?: string; value: string; variablesReference: number } = {
            name: item.name,
            value: String(item.value?.description ?? item.value?.value ?? ''),
            variablesReference: nestedId ? refForObject(nestedId) : 0,
          };
          if (typeof item.value?.type === 'string') mapped.type = item.value.type;
          return mapped;
          }),
      };
    }
    if (method === 'continue') {
      if (cdp) await cdp.request('Debugger.resume');
      return { allThreadsContinued: true };
    }
    if (method === 'next') {
      if (cdp) await cdp.request('Debugger.stepOver');
      return {};
    }
    if (method === 'stepIn') {
      if (cdp) await cdp.request('Debugger.stepInto');
      return {};
    }
    if (method === 'stepOut') {
      if (cdp) await cdp.request('Debugger.stepOut');
      return {};
    }
    if (method === 'pause') {
      if (cdp) await cdp.request('Debugger.pause');
      return {};
    }
    if (method === 'evaluate') {
      const expression = typeof request.expression === 'string' ? request.expression : '';
      const frameIndex = Math.max(0, Number(request.frameId ?? 1) - 1);
      const frame = pausedEvent?.callFrames?.[frameIndex];
      if (!cdp || !expression) return { result: 'undefined', variablesReference: 0 };
      if (frame?.callFrameId) {
        const result = await cdp.request('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression,
          returnByValue: true,
        });
        const value = asRecord(result.result);
        return {
          result: String(value.description ?? value.value ?? 'undefined'),
          variablesReference: 0,
        };
      }
      const result = await cdp.request('Runtime.evaluate', { expression, returnByValue: true });
      const value = asRecord(result.result);
      return {
        result: String(value.description ?? value.value ?? 'undefined'),
        variablesReference: 0,
      };
    }
    if (method === 'disconnect' || method === 'terminate') {
      try {
        child?.kill();
      } catch {
        // Process may already have exited.
      }
      cdp?.close();
      process.exit(0);
    }
    return {};
  },
});
