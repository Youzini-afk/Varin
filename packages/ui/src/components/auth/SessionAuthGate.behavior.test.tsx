import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeAPIs } from '@varin/application-client';

type ComponentFn<P extends Record<string, unknown> = Record<string, unknown>> = (props: P) => unknown;

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

type HookEffect = () => void | (() => void);
type HookCallback = (...args: unknown[]) => unknown;
type JSXProps = Record<string, unknown> & { children?: unknown };
type JSXElementType<P extends Record<string, unknown> = Record<string, unknown>> = ComponentFn<P> | string | symbol;

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void> = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', originalDocument);
  } else {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

const resetHarness = () => {
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
  desktopShell = false;
  runtimeApiBaseUrl = '';
  runtimeKey = 'local';
  runtimeStatusCode = 401;
  restoreDirectoryPreferences = () => Promise.resolve();
  initialLoadingLeaving = false;
  initialLoadingRemoved = false;
  initialSplashHandoffSet = false;
  initialSplashHandoffReleased = false;
  runtimeEndpointChangedListener = null;
  desktopInvoke = async () => null;
  desktopHostsGetCalls = 0;
  desktopHostsSetCalls = 0;
  runtimeSwitchCalls = 0;
  const testWindow = {
    isSecureContext: false,
    localStorage: {
      getItem: () => null,
      setItem: () => undefined,
    },
    setTimeout: (callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    },
    clearTimeout: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
  const documentElement = {
    setAttribute: (name: string, value: string) => {
      if (name === 'data-varin-splash-handoff' && value === 'true') initialSplashHandoffSet = true;
    },
    removeAttribute: (name: string) => {
      if (name === 'data-varin-splash-handoff') initialSplashHandoffReleased = true;
    },
  };
  const testDocument = {
    defaultView: testWindow,
    documentElement,
    getElementById: (id: string): unknown => {
      void id;
      return null;
    },
  };
  const initialLoadingElement = {
    ownerDocument: testDocument,
    style: { opacity: '' },
    setAttribute: (name: string, value: string) => {
      if (name === 'data-leaving' && value === 'true') initialLoadingLeaving = true;
    },
    remove: () => { initialLoadingRemoved = true; },
  };
  testDocument.getElementById = (id: string) => id === 'initial-loading' ? initialLoadingElement : null;
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: testDocument,
  });
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getRecord = (component: unknown): HookRecord => {
  const existing = hookRecords.get(component);
  if (existing) return existing;
  const record: HookRecord = { values: [], deps: [] };
  hookRecords.set(component, record);
  return record;
};

const getHookRecord = (): HookRecord => {
  if (!currentRecord) {
    throw new Error('Hooks can only run during a render pass');
  }
  return currentRecord;
};

const renderComponent = <P extends Record<string, unknown>>(component: ComponentFn<P>, props: P): unknown => {
  const previousRecord = currentRecord;
  const previousHookIndex = hookIndex;
  currentRecord = getRecord(component);
  hookIndex = 0;

  try {
    return component(props);
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousHookIndex;
  }
};

function useCallback<T extends HookCallback>(callback: T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useEffect(effect: HookEffect, deps?: unknown[]): void {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.deps[index] = deps;
    pendingEffects.push(() => {
      effect();
    });
  }
}

function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = factory();
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useRef<T>(initialValue: T): { current: T } {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = { current: initialValue };
  }
  return record.values[index] as { current: T };
}

function useState<T>(initialValue: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = typeof initialValue === 'function'
      ? (initialValue as () => T)()
      : initialValue;
  }

  const setState = (next: T | ((prev: T) => T)) => {
    record.values[index] = typeof next === 'function'
      ? (next as (prev: T) => T)(record.values[index] as T)
      : next;
  };

  return [record.values[index] as T, setState] as const;
}

function jsx<P extends Record<string, unknown>>(type: JSXElementType<P>, props: JSXProps & P): unknown {
  if (type === reactJsxRuntime.Fragment) {
    return props.children ?? null;
  }

  if (typeof type === 'function') {
    return renderComponent(type, props as P);
  }

  return { type, props };
}

const ReactMock = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
};

const reactJsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
};

let desktopShell = false;
let runtimeFetchRejects = true;
let runtimeApiBaseUrl = '';
let runtimeKey = 'local';
let runtimeStatusCode = 401;
let restoreDirectoryPreferences: () => Promise<void> = () => Promise.resolve();
let runtimeEndpointChangedListener: (() => void) | null = null;
let desktopInvoke: () => Promise<unknown> = async () => null;
let desktopHostsGetCalls = 0;
let desktopHostsSetCalls = 0;
let runtimeSwitchCalls = 0;
let initialLoadingLeaving = false;
let initialLoadingRemoved = false;
let initialSplashHandoffSet = false;
let initialSplashHandoffReleased = false;

mock.module('react/jsx-runtime', () => reactJsxRuntime);
mock.module('react/jsx-dev-runtime', () => reactJsxRuntime);

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

mock.module('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: mock(() => false),
}));

mock.module('@remixicon/react', () => ({
  RiLoader4Line: () => null,
  RiLockLine: () => null,
  RiLockUnlockLine: () => null,
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children }: { children?: unknown }) => children ?? null,
}));

mock.module('@/components/ui/checkbox', () => ({
  Checkbox: () => null,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: JSXProps) => ({ type: 'input', props }),
}));

mock.module('@/components/ui', () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
    message: mock(() => undefined),
  },
}));

mock.module('@/components/ui/VarinLogo', () => ({
  VarinLogo: () => 'logo',
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/components/desktop/DesktopHostSwitcher', () => ({
  DesktopHostSwitcherInline: () => 'host-switcher',
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/lib/desktop', () => ({
  invokeDesktop: () => desktopInvoke(),
  isDesktopShell: mock(() => desktopShell),
}));

mock.module('@/lib/persistence', () => ({
  initializeAppearancePreferences: mock(() => Promise.resolve()),
  syncDesktopSettings: mock(() => Promise.resolve()),
}));

mock.module('@/lib/directoryPersistence', () => ({
  applyPersistedDirectoryPreferences: mock(() => restoreDirectoryPreferences()),
}));

mock.module('@varin/application-client', () => ({
  getRuntimeApiBaseUrl: () => runtimeApiBaseUrl,
  getRuntimeExtraHeadersSync: mock(() => ({})),
  getRuntimeKey: () => runtimeKey,
  runtimeFetch: mock(async () => {
    if (runtimeFetchRejects) {
      throw new Error('offline');
    }

    return new Response(JSON.stringify({ authenticated: runtimeStatusCode === 200 }), {
      status: runtimeStatusCode,
      headers: { 'content-type': 'application/json' },
    });
  }),
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeEndpointChangedListener = listener;
    return () => {
      if (runtimeEndpointChangedListener === listener) runtimeEndpointChangedListener = null;
    };
  },
  switchRuntimeEndpointSafely: async () => { runtimeSwitchCalls += 1; },
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostsGet: () => {
    desktopHostsGetCalls += 1;
    return Promise.resolve(null);
  },
  desktopHostsSet: () => {
    desktopHostsSetCalls += 1;
    return Promise.resolve();
  },
  getDesktopHostApiUrl: mock(() => ''),
  normalizeHostUrl: mock(() => ''),
}));

mock.module('@/lib/passkeys', () => ({
  authenticateWithPasskey: mock(() => Promise.resolve(null)),
  cancelPasskeyCeremony: mock(() => undefined),
  defaultPasskeyStatus: { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null },
  fetchPasskeyStatus: mock(() => Promise.resolve({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null })),
  isPasskeyCeremonyAbort: mock(() => false),
  registerCurrentDevicePasskey: mock(() => Promise.resolve(null)),
}));

const { SessionAuthGate } = await import('./SessionAuthGate');
const runtimeApis = {} as RuntimeAPIs;

const flushEffects = async () => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      effect();
    }
    await Promise.resolve();
  }
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

const renderGate = async () => {
  const firstPass = renderComponent(SessionAuthGate, { apis: runtimeApis, children: 'child' });
  await flushEffects();
  const secondPass = renderComponent(SessionAuthGate, { apis: runtimeApis, children: 'child' });
  await flushEffects();
  return secondPass ?? firstPass;
};

const collectText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(' ');
  if (typeof node === 'object') {
    const element = node as { props?: { children?: unknown } };
    return collectText(element.props?.children);
  }
  return '';
};

const findElement = (node: unknown, type: string): { type: string; props: JSXProps } | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as { type?: unknown; props?: JSXProps };
  if (element.type === type && element.props) return { type, props: element.props };
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child, type);
      if (match) return match;
    }
    return null;
  }
  return findElement(children, type);
};

describe('SessionAuthGate status-check failure behavior', () => {
  test('keeps non-desktop status-check rejection on the error screen', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.locked.unlockTitle');
  });

  test('keeps desktop-shell status-check rejection on the locked password prompt', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.locked.unlockTitle');
    expect(text).not.toContain('sessionAuth.error.networkTitle');
    expect(initialLoadingLeaving).toBe(true);
    expect(initialLoadingRemoved).toBe(true);
    expect(initialSplashHandoffSet).toBe(true);
    expect(initialSplashHandoffReleased).toBe(true);
  });

  test('waits for authenticated settings and workspace restoration before mounting the app', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    runtimeStatusCode = 200;
    let finishRestore = () => {};
    restoreDirectoryPreferences = () => new Promise<void>((resolve) => { finishRestore = resolve; });

    const loadingTree = await renderGate();
    expect(collectText(loadingTree)).not.toContain('child');

    finishRestore();
    await Promise.resolve();
    await Promise.resolve();
    const readyTree = await renderGate();
    await flushEffects();

    expect(collectText(readyTree)).toContain('child');
  });

  test('discards a password completion after switching to another host', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    runtimeApiBaseUrl = 'https://host-a.example';
    runtimeKey = 'host:a';
    let resolveLogin: (value: unknown) => void = () => {
      throw new Error('Password login did not start');
    };
    desktopInvoke = () => new Promise((resolve) => { resolveLogin = resolve; });

    const lockedTree = await renderGate();
    const input = findElement(lockedTree, 'input');
    expect(input).not.toBeNull();
    (input?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'password-a' } });

    const passwordTree = await renderGate();
    const form = findElement(passwordTree, 'form');
    expect(form).not.toBeNull();
    const pending = (form?.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => undefined });
    await Promise.resolve();

    runtimeApiBaseUrl = 'https://host-b.example';
    runtimeKey = 'host:b';
    runtimeEndpointChangedListener?.();
    resolveLogin({ token: 'token-a' });
    await pending;

    expect(desktopHostsGetCalls).toBe(0);
    expect(desktopHostsSetCalls).toBe(0);
    expect(runtimeSwitchCalls).toBe(0);
  });
});
