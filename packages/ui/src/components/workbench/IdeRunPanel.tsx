import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useWorkbenchWorkspaceId } from '@/lib/extensions/workbench-workspace';
import {
  acquireRunDebugView,
  peekLastStackFrame,
  peekLastTestFailure,
  rememberStackFrame,
  releaseRunDebugView,
  subscribeRunDebugUi,
} from '@/lib/run-debug/session';
import { revealResourceInEditor } from '@/lib/agent-editor/navigation';
import type {
  VarinBreakpoint,
  VarinDebugSessionStatus,
  VarinDebugStackFrame,
  VarinDebugVariable,
  VarinTaskConfiguration,
  VarinTestItem,
} from '@varin/application-client';
import { RunServicesError } from '@varin/application-client';
import { ideDebugControlAvailability } from '@/lib/workbench/ide-debug-controls';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useEditorContextStore } from '@/stores/useEditorContextStore';
import { languageIdFromResourceId } from '@/lib/language-services/language-id';

type TasksState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; configurations: VarinTaskConfiguration[] }
  | { status: 'failure'; message: string };

type TestsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; tests: VarinTestItem[] }
  | { status: 'failure'; message: string };

const ignoreStale = (error: unknown): boolean => (
  error instanceof RunServicesError && error.reason === 'stale-completion'
);

export const IdeRunPanel: React.FC = () => {
  const { t } = useI18n();
  const workspaceId = useWorkbenchWorkspaceId();
  const directory = useDirectoryStore((state) => state.currentDirectory);
  const activeEditorFile = useEditorContextStore((state) => state.activeEditorFile);
  const apis = useRuntimeAPIs();
  const [tasks, setTasks] = React.useState<TasksState>({ status: 'idle' });
  const [tests, setTests] = React.useState<TestsState>({ status: 'idle' });
  const [debugStatus, setDebugStatus] = React.useState<VarinDebugSessionStatus | null>(null);
  const [breakpoints, setBreakpoints] = React.useState<VarinBreakpoint[]>([]);
  const [stack, setStack] = React.useState<VarinDebugStackFrame[]>([]);
  const [variables, setVariables] = React.useState<VarinDebugVariable[]>([]);
  const [watch, setWatch] = React.useState<string[]>([]);
  const [watchDraft, setWatchDraft] = React.useState('');
  const [consoleLines, setConsoleLines] = React.useState<string[]>([]);
  const [consoleDraft, setConsoleDraft] = React.useState('');
  const [program, setProgram] = React.useState('');
  const refreshGenerationRef = React.useRef(0);
  const workspaceIdRef = React.useRef(workspaceId);
  const testOwnerRef = React.useRef<{ runId: string; generation: number } | null>(null);
  workspaceIdRef.current = workspaceId;
  const uiEpoch = React.useSyncExternalStore(subscribeRunDebugUi, () => peekLastTestFailure(workspaceId ?? '')?.id ?? '', () => '');
  const debugControls = ideDebugControlAvailability(debugStatus);
  const activeEditorResourceId = activeEditorFile && activeEditorFile.workspaceId === workspaceId
    ? activeEditorFile.relativePath
    : null;

  const reportActionFailure = React.useCallback((error: unknown) => {
    toast.error(error instanceof Error ? error.message : t('common.unavailable'));
  }, [t]);

  const runAction = React.useCallback((operation: () => Promise<unknown>) => {
    const ownerWorkspaceId = workspaceId;
    if (!ownerWorkspaceId) return;
    void operation().catch((error) => {
      if (workspaceIdRef.current === ownerWorkspaceId) reportActionFailure(error);
    });
  }, [reportActionFailure, workspaceId]);

  const runDebugAction = React.useCallback((operation: () => Promise<VarinDebugSessionStatus>) => {
    const ownerWorkspaceId = workspaceId;
    if (!ownerWorkspaceId) return;
    void operation().then((snapshot) => {
      if (workspaceIdRef.current === ownerWorkspaceId && snapshot.workspaceId === ownerWorkspaceId) {
        setDebugStatus(snapshot);
        if ((snapshot.status === 'absent' || snapshot.status === 'failed') && snapshot.message) {
          toast.error(snapshot.message);
        }
      }
    }).catch(reportActionFailure);
  }, [reportActionFailure, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId) return undefined;
    acquireRunDebugView(workspaceId);
    return () => {
      releaseRunDebugView(workspaceId);
    };
  }, [workspaceId]);

  const refresh = React.useCallback(async () => {
    if (!workspaceId) return;
    const generation = ++refreshGenerationRef.current;
    const isCurrent = () => (
      refreshGenerationRef.current === generation && workspaceIdRef.current === workspaceId
    );
    setTasks({ status: 'loading' });
    setTests({ status: 'loading' });
    try {
      const listed = await apis.tasks.list(workspaceId);
      if (!isCurrent()) return;
      if (listed.status === 'failure') setTasks({ status: 'failure', message: listed.message });
      else if (listed.configurations.length === 0) setTasks({ status: 'empty' });
      else setTasks({ status: 'ready', configurations: listed.configurations });
    } catch (error) {
      if (isCurrent() && !ignoreStale(error)) {
        setTasks({ status: 'failure', message: error instanceof Error ? error.message : 'failed' });
      }
    }
    try {
      const discovered = await apis.tests.discover({ workspaceId });
      if (!isCurrent()) return;
      if (discovered.status === 'failure') setTests({ status: 'failure', message: discovered.message });
      else if (discovered.status === 'empty' || discovered.tests.length === 0) setTests({ status: 'empty' });
      else setTests({ status: 'ready', tests: discovered.tests });
      const status = await apis.tests.getStatus(workspaceId);
      if (!isCurrent()) return;
      testOwnerRef.current = status.runId && typeof status.generation === 'number'
        ? { runId: status.runId, generation: status.generation }
        : null;
    } catch (error) {
      if (isCurrent() && !ignoreStale(error)) {
        setTests({ status: 'failure', message: error instanceof Error ? error.message : 'failed' });
      }
    }
    try {
      const status = await apis.debug.getStatus(workspaceId);
      if (!isCurrent()) return;
      setDebugStatus(status);
      const listedBreakpoints = await apis.debug.listBreakpoints(workspaceId);
      if (!isCurrent()) return;
      setBreakpoints(listedBreakpoints.breakpoints);
      const listedWatch = await apis.debug.listWatch(workspaceId);
      if (!isCurrent()) return;
      setWatch(listedWatch.expressions);
      if (status.status === 'paused') {
        const threads = await apis.debug.getThreads({ workspaceId });
        if (!isCurrent()) return;
        if (
          threads.status !== 'ready'
          || threads.sessionId !== status.sessionId
          || threads.generation !== status.generation
          || !threads.value[0]
        ) return;
        const frames = await apis.debug.getStack({ workspaceId, threadId: threads.value[0].id });
        if (!isCurrent()) return;
        if (
          frames.status === 'ready'
          && frames.sessionId === status.sessionId
          && frames.generation === status.generation
        ) {
          setStack(frames.value);
          const top = frames.value[0];
          if (top) rememberStackFrame(workspaceId, top);
          if (top) {
            const scopes = await apis.debug.getScopes({ workspaceId, frameId: top.id });
            if (!isCurrent()) return;
            if (
              scopes.status === 'ready'
              && scopes.sessionId === status.sessionId
              && scopes.generation === status.generation
              && scopes.value[0]
            ) {
              const vars = await apis.debug.getVariables({
                workspaceId,
                variablesReference: scopes.value[0].variablesReference,
              });
              if (!isCurrent()) return;
              if (
                vars.status === 'ready'
                && vars.sessionId === status.sessionId
                && vars.generation === status.generation
              ) setVariables(vars.value);
            }
          }
        }
      } else {
        setStack([]);
        setVariables([]);
      }
    } catch (error) {
      if (isCurrent() && !ignoreStale(error)) {
        setDebugStatus({ status: 'failed', workspaceId, message: error instanceof Error ? error.message : 'failed' });
      }
    }
  }, [apis.debug, apis.tasks, apis.tests, workspaceId]);

  React.useEffect(() => {
    refreshGenerationRef.current += 1;
    setTasks({ status: 'idle' });
    setTests({ status: 'idle' });
    setDebugStatus(null);
    setBreakpoints([]);
    setStack([]);
    setVariables([]);
    setWatch([]);
    setWatchDraft('');
    setConsoleLines([]);
    setConsoleDraft('');
    setProgram('');
    testOwnerRef.current = null;
  }, [workspaceId]);

  React.useEffect(() => {
    if (activeEditorResourceId) setProgram(activeEditorResourceId);
  }, [activeEditorResourceId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh, uiEpoch]);

  React.useEffect(() => {
    if (!workspaceId) return undefined;
    const close = [
      apis.tasks.subscribe(workspaceId, (event) => {
        if (workspaceIdRef.current !== workspaceId) return;
        if (event.kind === 'output') setConsoleLines((lines) => [...lines, event.text]);
      }),
      apis.debug.subscribe(workspaceId, (event) => {
        if (workspaceIdRef.current !== workspaceId) return;
        if (event.kind === 'output') setConsoleLines((lines) => [...lines, event.text]);
        if (event.kind === 'status') {
          setDebugStatus(event.snapshot);
          if (event.snapshot.status === 'paused' || event.snapshot.status === 'stopped' || event.snapshot.status === 'failed') {
            void refresh();
          }
        }
      }),
      apis.tests.subscribe(workspaceId, (event) => {
        if (workspaceIdRef.current !== workspaceId) return;
        if (event.kind === 'status') {
          testOwnerRef.current = event.snapshot.runId && typeof event.snapshot.generation === 'number'
            ? { runId: event.snapshot.runId, generation: event.snapshot.generation }
            : null;
          return;
        }
        const owner = testOwnerRef.current;
        if (!owner || event.runId !== owner.runId || event.generation !== owner.generation) return;
        if (event.kind === 'output') setConsoleLines((lines) => [...lines, event.text]);
        if (event.kind === 'test' && event.test.status) {
          setTests((current) => {
            if (current.status !== 'ready') return current;
            return {
              status: 'ready',
              tests: current.tests.map((item) => (item.id === event.test.id ? { ...item, ...event.test } : item)),
            };
          });
        }
      }),
    ];
    return () => {
      for (const subscription of close) subscription.close();
    };
  }, [apis.debug, apis.tasks, apis.tests, refresh, workspaceId]);

  const selectStackFrame = React.useCallback((frame: VarinDebugStackFrame): void => {
    if (!workspaceId) return;
    rememberStackFrame(workspaceId, frame);
    if (frame.resourceId) {
      revealResourceInEditor({
        workspaceId,
        workspaceRoot: directory,
        resourceId: frame.resourceId,
        line: frame.line,
        column: frame.column,
      });
    }
    const ownerSessionId = debugStatus && 'sessionId' in debugStatus ? debugStatus.sessionId : undefined;
    const ownerGeneration = debugStatus && 'generation' in debugStatus ? debugStatus.generation : undefined;
    if (
      debugStatus?.status !== 'paused'
      || !ownerSessionId
      || typeof ownerGeneration !== 'number'
    ) return;
    runAction(async () => {
      const scopes = await apis.debug.getScopes({ workspaceId, frameId: frame.id });
      if (
        scopes.status !== 'ready'
        || scopes.sessionId !== ownerSessionId
        || scopes.generation !== ownerGeneration
      ) return;
      const scope = scopes.value[0];
      if (!scope) {
        setVariables([]);
        return;
      }
      const nextVariables = await apis.debug.getVariables({
        workspaceId,
        variablesReference: scope.variablesReference,
      });
      if (
        nextVariables.status === 'ready'
        && nextVariables.sessionId === ownerSessionId
        && nextVariables.generation === ownerGeneration
      ) setVariables(nextVariables.value);
    });
  }, [apis.debug, debugStatus, directory, runAction, workspaceId]);

  if (!workspaceId) {
    return (
      <div className="p-3 typography-ui text-muted-foreground">{t('workbench.ide.run.noWorkspace')}</div>
    );
  }

  const unsupported = debugStatus?.status === 'absent' && tasks.status === 'empty' && tests.status === 'empty';

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3 typography-ui">
      {unsupported ? (
        <p className="text-muted-foreground">{t('workbench.ide.run.unsupported')}</p>
      ) : null}
      <section className="mb-4">
        <div className="mb-2 font-medium text-foreground">{t('workbench.ide.run.tasks')}</div>
        {tasks.status === 'failure' ? (
          <p className="text-[color:var(--status-error)]">{t('workbench.ide.run.tasksFailed', { message: tasks.message })}</p>
        ) : tasks.status === 'empty' || tasks.status === 'idle' ? (
          <p className="text-muted-foreground">{t('workbench.ide.run.emptyTasks')}</p>
        ) : tasks.status === 'ready' ? (
          <ul className="flex flex-col gap-1">
            {tasks.configurations.map((item) => (
              <li key={item.id}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start"
                  onClick={() => {
                    setConsoleLines([]);
                    runAction(async () => {
                      const result = await apis.tasks.run({ workspaceId, taskId: item.id });
                      if (result.status === 'failed') throw new Error(result.message || t('common.unavailable'));
                    });
                  }}
                >
                  {t('workbench.ide.run.runTask', { label: item.label })}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        )}
      </section>

      <section className="mb-4">
        <div className="mb-2 font-medium text-foreground">{t('workbench.ide.debug.title')}</div>
        <div className="mb-2 flex flex-wrap gap-1">
          <Button type="button" size="xs" disabled={!debugControls.canStart} onClick={() => {
            setConsoleLines([]);
            runDebugAction(() => apis.debug.start({
              workspaceId,
              ...(program ? { program, languageId: languageIdFromResourceId(program) } : {}),
            }));
          }}>
            {t('workbench.ide.debug.start')}
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={!debugControls.canStop} onClick={() => runDebugAction(() => apis.debug.stop({ workspaceId }))}>
            {t('workbench.ide.debug.stop')}
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={!debugControls.canContinue} onClick={() => runDebugAction(() => apis.debug.continue({ workspaceId }))}>
            {t('workbench.ide.debug.continue')}
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={!debugControls.canStep} onClick={() => runDebugAction(() => apis.debug.stepOver({ workspaceId }))}>
            {t('workbench.ide.debug.stepOver')}
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={!debugControls.canStep} onClick={() => runDebugAction(() => apis.debug.stepIn({ workspaceId }))}>
            {t('workbench.ide.debug.stepInto')}
          </Button>
          <Button type="button" size="xs" variant="ghost" disabled={!debugControls.canStep} onClick={() => runDebugAction(() => apis.debug.stepOut({ workspaceId }))}>
            {t('workbench.ide.debug.stepOut')}
          </Button>
        </div>
        <Input
          value={program}
          onChange={(event) => setProgram(event.target.value)}
          aria-label={t('workbench.ide.debug.programAria')}
          className="mb-2"
        />
        <p className="mb-2 text-muted-foreground">
          {debugStatus?.status === 'paused'
            ? t('workbench.ide.debug.paused')
            : debugStatus?.status === 'running' || debugStatus?.status === 'starting'
              ? t('workbench.ide.debug.running')
              : debugStatus?.status === 'failed'
                ? t('workbench.ide.debug.failed', { message: debugStatus.message ?? '' })
                : t('workbench.ide.debug.absent')}
        </p>
        <div className="mb-2">
          <div className="text-muted-foreground">{t('workbench.ide.debug.breakpoints')}</div>
          {breakpoints.length === 0 ? (
            <p className="text-muted-foreground">{t('workbench.ide.debug.breakpointsEmpty')}</p>
          ) : (
            <ul>
              {breakpoints.map((item) => (
                <li key={`${item.resourceId}:${item.line}`}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start"
                    onClick={() => revealResourceInEditor({
                      workspaceId,
                      workspaceRoot: directory,
                      resourceId: item.resourceId,
                      line: item.line,
                    })}
                  >
                    {item.resourceId}:{item.line}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mb-2">
          <div className="text-muted-foreground">{t('workbench.ide.debug.callStack')}</div>
          <ul>
            {stack.map((frame) => (
              <li key={frame.id}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn('h-auto w-full justify-start')}
                  onClick={() => selectStackFrame(frame)}
                >
                  {frame.name}:{frame.line}
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <div className="mb-2">
          <div className="text-muted-foreground">{t('workbench.ide.debug.variables')}</div>
          <ul>
            {variables.map((variable) => (
              <li key={variable.name} className="text-foreground">{variable.name} = {variable.value}</li>
            ))}
          </ul>
        </div>
        <div className="mb-2">
          <div className="text-muted-foreground">{t('workbench.ide.debug.watch')}</div>
          <form
            className="mb-1 flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const expression = watchDraft.trim();
              if (!expression) return;
              runAction(async () => {
                const result = await apis.debug.addWatch({ workspaceId, expression });
                if (workspaceIdRef.current !== workspaceId) return;
                if (result.status === 'failed') throw new Error(result.message || t('common.unavailable'));
                if (result.expressions) setWatch(result.expressions);
              });
              setWatchDraft('');
            }}
          >
            <Input value={watchDraft} onChange={(event) => setWatchDraft(event.target.value)} aria-label={t('workbench.ide.debug.watchAdd')} />
            <Button type="submit" size="xs">{t('workbench.ide.debug.watchAdd')}</Button>
          </form>
          <ul>
            {watch.map((expression) => (
              <li key={expression} className="flex items-center justify-between gap-2">
                <span>{expression}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => runAction(async () => {
                  const result = await apis.debug.removeWatch({ workspaceId, expression });
                  if (workspaceIdRef.current !== workspaceId) return;
                  setWatch(result.expressions);
                })}
                >
                  {t('workbench.ide.debug.watchRemove')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-medium text-foreground">{t('workbench.ide.tests.title')}</span>
          <div className="flex gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => void refresh()}>{t('workbench.ide.tests.discover')}</Button>
            <Button type="button" size="xs" disabled={tests.status !== 'ready' || tests.tests.length === 0} onClick={() => {
              setConsoleLines([]);
              runAction(async () => {
                const result = await apis.tests.run({ workspaceId });
                if (result.status === 'failed' || result.status === 'absent' || result.status === 'empty') {
                  throw new Error(result.message || t('common.unavailable'));
                }
              });
            }}>{t('workbench.ide.tests.run')}</Button>
          </div>
        </div>
        {tests.status === 'failure' ? (
          <p className="text-[color:var(--status-error)]">{t('workbench.ide.tests.failedLoad', { message: tests.message })}</p>
        ) : tests.status === 'empty' || tests.status === 'idle' ? (
          <p className="text-muted-foreground">{t('workbench.ide.tests.empty')}</p>
        ) : tests.status === 'ready' ? (
          <ul className="flex flex-col gap-1">
            {tests.tests.map((item) => (
              <li key={item.id}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start"
                  onClick={() => {
                    if (item.resourceId) {
                      revealResourceInEditor({
                        workspaceId,
                        workspaceRoot: directory,
                        resourceId: item.resourceId,
                        ...(typeof item.line === 'number' ? { line: item.line } : {}),
                      });
                    }
                    if (item.status === 'failed') return;
                    setConsoleLines([]);
                    runAction(async () => {
                      const result = await apis.tests.run({ workspaceId, testIds: [item.id] });
                      if (result.status === 'failed' || result.status === 'absent' || result.status === 'empty') {
                        throw new Error(result.message || t('common.unavailable'));
                      }
                    });
                  }}
                >
                  {item.status === 'failed'
                    ? t('workbench.ide.tests.failedItem', { label: item.label })
                    : item.status === 'passed'
                      ? t('workbench.ide.tests.passedItem', { label: item.label })
                      : item.status === 'running'
                        ? t('workbench.ide.tests.runningItem', { label: item.label })
                        : item.label}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{t('common.loading')}</p>
        )}
      </section>

      <section className="min-h-[6rem]">
        <div className="mb-1 font-medium text-foreground">{t('workbench.ide.debug.console')}</div>
        <pre className="mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 p-2 typography-code text-muted-foreground">
          {consoleLines.join('') || t('workbench.panel.outputEmpty')}
        </pre>
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const expression = consoleDraft.trim();
            if (!expression) return;
            runAction(async () => {
              const frame = peekLastStackFrame(workspaceId);
              const result = await apis.debug.evaluate({
                workspaceId,
                expression,
                ...(frame ? { frameId: frame.id } : {}),
              });
              if (workspaceIdRef.current !== workspaceId) return;
              if (result.status === 'failed') throw new Error(result.message);
              if (result.status === 'absent') throw new Error(t('common.unavailable'));
              setConsoleLines((lines) => [...lines, `${expression} => ${result.value}\n`]);
            });
            setConsoleDraft('');
          }}
        >
          <Input value={consoleDraft} onChange={(event) => setConsoleDraft(event.target.value)} aria-label={t('workbench.ide.debug.consolePlaceholder')} />
          <Button type="submit" size="xs">{t('workbench.ide.debug.evaluate')}</Button>
        </form>
      </section>
    </div>
  );
};
