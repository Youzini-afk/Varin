import React from 'react';
import { json } from '@codemirror/lang-json';
import type {
  PiConfigTextDocumentSnapshot,
  PiMcpConfigServer,
  PiMcpConfigSource,
  RuntimeContextTarget,
} from '@varin/protocol';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { Icon } from '@/components/icon/Icon';
import { useResourceRuntimeTarget } from '@/components/sections/resources/useResourceRuntimeTarget';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n, type I18nParams } from '@/lib/i18n';
import {
  getPiConfigTextDocument,
  updatePiConfigTextDocument,
} from '@/lib/pi-runtime/config-documents';
import { getRuntimeKey } from '@varin/application-client';
import { cn } from '@/lib/utils';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import {
  MCP_ADAPTER_STATUS_CHANNEL,
  mcpServerCommandArgument,
  parseMcpAdapterStatus,
  type McpAdapterServerSnapshot,
} from './mcpAdapterStatus';
import { McpStructuredConfigEditor } from './McpStructuredConfigEditor';
import { McpServerStatusBadge } from './McpServerStatusBadge';
import {
  canLeaveMcpConfigSource,
  mcpSourceBoundSnapshot,
  mcpServerTransport,
  parseMcpConfigObject,
  prepareMcpConfigForSave,
} from './mcp-config-model';
import {
  refreshMcpCatalog,
  selectMcpCatalogItemIfCurrent,
  setMcpCatalogEditorDirty,
  useMcpCatalogState,
} from './mcp-catalog-store';

const transportLabelKey = (kind: PiMcpConfigServer['transport']['kind']): string => (
  `settings.varin.mcp.structured.transport.${kind === 'stdio'
    ? 'localCommand'
    : kind === 'socket'
      ? 'localSocket'
      : kind}`
);

const McpConfigEditor: React.FC<{
  native: boolean;
  mode: 'new' | 'server' | 'settings';
  preferredServerName?: string;
  runtimeTarget: RuntimeContextTarget;
  sources: PiMcpConfigSource[];
  targetKey: string;
  refreshRevision: number;
}> = ({ native, mode, preferredServerName, runtimeTarget, sources, targetKey, refreshRevision }) => {
  const { t } = useI18n();
  const text = (key: string, params?: I18nParams): string => t(key as never, params);
  const [sourceId, setSourceId] = React.useState('');
  const [snapshot, setSnapshot] = React.useState<PiConfigTextDocumentSnapshot | null>(null);
  const [snapshotSourceKey, setSnapshotSourceKey] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('{}\n');
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [rawOpen, setRawOpen] = React.useState(false);
  const [createdServerName, setCreatedServerName] = React.useState<string | null>(null);
  const generationRef = React.useRef(0);
  const mutationRevisionRef = React.useRef(0);
  const dirtyRef = React.useRef(false);
  const sourceKeyRef = React.useRef('');
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;
  const editorExtensions = React.useMemo(() => [json()], []);
  const source = sources.find((candidate) => candidate.id === sourceId);
  const sourceKey = source
    ? `${source.id}:${source.target.root}:${source.target.path}:${source.target.format}`
    : '';
  sourceKeyRef.current = sourceKey;
  const preferredSourceId = React.useMemo(() => {
    if (mode === 'server' && preferredServerName) {
      return sources
        .filter((candidate) => candidate.serverNames.includes(preferredServerName))
        .sort((left, right) => right.order - left.order)[0]?.id ?? '';
    }
    if (mode === 'new') {
      return sources.find((candidate) => candidate.id === 'pi-project')?.id
        ?? sources.find((candidate) => candidate.id === 'pi-global')?.id
        ?? sources.slice().sort((left, right) => right.order - left.order)[0]?.id
        ?? '';
    }
    return sources.find((candidate) => candidate.id === 'pi-project')?.id
      ?? sources.slice().sort((left, right) => right.order - left.order)[0]?.id
      ?? '';
  }, [mode, preferredServerName, sources]);

  React.useEffect(() => {
    generationRef.current += 1;
    setSourceId(preferredSourceId);
    setSnapshot(null);
    setSnapshotSourceKey(null);
    setDraft('{}\n');
    setLoadError(null);
    setLoading(false);
    setCreatedServerName(null);
  }, [preferredServerName, preferredSourceId, targetKey]);

  const load = React.useCallback(async () => {
    if (!source) return;
    const generation = ++generationRef.current;
    const mutationRevision = mutationRevisionRef.current;
    const actionTargetKey = targetKey;
    const actionSourceKey = sourceKey;
    const runtimeKey = getRuntimeKey();
    setLoading(true);
    setLoadError(null);
    try {
      const next = await getPiConfigTextDocument(
        runtimeTarget,
        source.target.root,
        source.target.path,
        source.target.format,
      );
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || actionSourceKey !== sourceKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      if (mutationRevision !== mutationRevisionRef.current) return;
      setSnapshot(next);
      setSnapshotSourceKey(actionSourceKey);
      setDraft(next.content);
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || actionSourceKey !== sourceKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (
        generation === generationRef.current
        && actionTargetKey === targetKeyRef.current
        && actionSourceKey === sourceKeyRef.current
        && runtimeKey === getRuntimeKey()
      ) setLoading(false);
    }
  }, [runtimeTarget, source, sourceKey, targetKey]);
  const loadRef = React.useRef(load);
  loadRef.current = load;

  const parsed = React.useMemo(() => {
    const errors: ParseError[] = [];
    const document = parse(draft.replace(/^\uFEFF/, ''), errors, {
      allowTrailingComma: !native,
      disallowComments: native,
    });
    if (errors.length > 0) {
      const first = errors[0];
      return {
        error: first
          ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
          : 'Invalid JSONC',
        valid: false,
      };
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
      return { error: 'Configuration root must be an object', valid: false };
    }
    return { error: null, valid: true };
  }, [draft, native]);
  const activeSnapshot = mcpSourceBoundSnapshot(snapshot, snapshotSourceKey, sourceKey);
  const dirty = activeSnapshot !== null && draft !== activeSnapshot.content;
  dirtyRef.current = dirty;
  const projectBlocked = source?.target.root === 'project' && activeSnapshot?.projectTrusted === false;
  const selectedTransport = createdServerName
    ? mcpServerTransport(parseMcpConfigObject(draft), createdServerName)
    : null;
  const newServerReady = mode !== 'new'
    || (createdServerName !== null && selectedTransport !== 'unconfigured');
  const contentToSave = activeSnapshot && parsed.valid
    ? native ? draft : prepareMcpConfigForSave(activeSnapshot.content, draft)
    : draft;
  const saveWillClearUrlCredentials = Boolean(activeSnapshot && contentToSave !== draft);

  React.useLayoutEffect(() => {
    setMcpCatalogEditorDirty(dirty);
    return () => setMcpCatalogEditorDirty(false);
  }, [dirty]);

  React.useEffect(() => {
    if (!sourceKey || dirtyRef.current) return;
    void loadRef.current();
  }, [refreshRevision, sourceKey]);

  const save = React.useCallback(async () => {
    if (!source || !activeSnapshot || !parsed.valid || !dirty || !newServerReady || projectBlocked || saving) return;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    const actionSourceKey = sourceKey;
    setSaving(true);
    try {
      const next = await updatePiConfigTextDocument(
        runtimeTarget,
        source.target.root,
        activeSnapshot.path,
        source.target.format,
        contentToSave,
        activeSnapshot.revision,
      );
      if (runtimeKey !== getRuntimeKey()) return;
      if (actionTargetKey !== targetKeyRef.current || actionSourceKey !== sourceKeyRef.current) {
        setSaving(false);
        return;
      }
      setSnapshot(next);
      setSnapshotSourceKey(actionSourceKey);
      setDraft(next.content);
      setMcpCatalogEditorDirty(false);
      await refreshMcpCatalog(runtimeTarget, targetKey, { force: true });
      if (mode === 'new' && createdServerName) {
        selectMcpCatalogItemIfCurrent(
          { kind: 'new' },
          { kind: 'server', name: createdServerName },
        );
      }
    } catch (error) {
      console.error('Failed to save MCP adapter configuration:', error);
      toast.error(error instanceof Error ? error.message : t('settings.common.status.saveFailed'));
    } finally {
      if (actionTargetKey === targetKeyRef.current && actionSourceKey === sourceKeyRef.current) setSaving(false);
    }
  }, [activeSnapshot, contentToSave, createdServerName, dirty, mode, newServerReady, parsed.valid, projectBlocked, runtimeTarget, saving, source, sourceKey, t, targetKey]);

  return (
    <SettingsSection
      settingsItem="mcp.configuration"
      divider={false}
    >
      <div className="space-y-4">
        <SettingsFieldRow
          label={text('settings.varin.mcp.config.source.label')}
          alignEnd={false}
          controlClassName="w-full max-w-lg"
        >
          <Select
            value={sourceId}
            disabled={loading || saving || !canLeaveMcpConfigSource(dirty)}
            onValueChange={(next) => {
              if (canLeaveMcpConfigSource(dirty)) setSourceId(next);
            }}
          >
            <SelectTrigger
              size="settings"
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={text('settings.varin.mcp.config.source.label')}
            >
              <SelectValue placeholder={text('settings.varin.mcp.config.source.label')} />
            </SelectTrigger>
            <SelectContent>
              {sources.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="font-mono typography-micro">{candidate.displayPath}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {source ? (
            <Button
              type="button"
              variant={dirty ? 'outline' : 'ghost'}
              size="sm"
              disabled={loading || saving}
              onClick={() => void load()}
              className="!font-normal gap-1.5"
            >
              <Icon name="refresh" className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
              {dirty
                ? text('settings.varin.mcp.config.actions.reloadDiscard')
                : text('settings.varin.mcp.config.actions.reload')}
            </Button>
          ) : null}
        </SettingsFieldRow>

        {source ? (
          <>
            <div className="space-y-1 typography-meta text-muted-foreground">
              <p className="break-all font-mono typography-micro">
                {activeSnapshot?.path ?? source.displayPath}
              </p>
            </div>

            {dirty ? (
              <p className="typography-meta text-[var(--status-warning)]">
                {text('settings.varin.mcp.config.source.dirtyGuard')}
              </p>
            ) : null}

            {activeSnapshot && parsed.valid ? (
              <McpStructuredConfigEditor
                native={native}
                project={source.scope === 'project'}
                content={draft}
                disabled={loading || saving || projectBlocked}
                mode={mode}
                onChange={(content) => {
                  mutationRevisionRef.current += 1;
                  setDraft(content);
                }}
                onCreatedServerNameChange={setCreatedServerName}
                serverName={preferredServerName}
              />
            ) : null}

            {activeSnapshot ? <Collapsible open={rawOpen || !parsed.valid} onOpenChange={setRawOpen}>
              <CollapsibleTrigger disabled={!parsed.valid} className="border border-border/60 px-3 py-2.5">
                <span className="typography-ui-label text-foreground">
                  {rawOpen || !parsed.valid
                    ? text('settings.varin.mcp.config.raw.hide')
                    : text('settings.varin.mcp.config.raw.show')}
                </span>
                <Icon name={rawOpen || !parsed.valid ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 text-muted-foreground" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="h-80 overflow-hidden rounded-md border border-border/60 bg-background">
                  <CodeMirrorEditor
                    value={draft}
                    onChange={(content) => {
                      mutationRevisionRef.current += 1;
                      setDraft(content);
                    }}
                    extensions={editorExtensions}
                    className="h-full"
                    enableSearch
                    readOnly={loading || saving || projectBlocked}
                  />
                </div>
              </CollapsibleContent>
            </Collapsible> : null}

            {parsed.error ? (
              <p className="typography-meta text-[var(--status-error)]">
                {t('settings.varin.mcp.config.invalid')}
              </p>
            ) : null}
            {projectBlocked && !loading ? (
              <p className="typography-meta text-[var(--status-warning)]">
                {t('settings.varin.mcp.config.untrusted')}
              </p>
            ) : null}
            {loadError ? (
              <p className="break-words typography-meta text-[var(--status-error)]">{loadError}</p>
            ) : null}
            {saveWillClearUrlCredentials ? (
              <p className="typography-meta text-[var(--status-warning)]">
                {text('settings.varin.mcp.structured.urlCredentialReset')}
              </p>
            ) : null}

            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={!activeSnapshot || loading || saving || !dirty || !parsed.valid || !newServerReady || projectBlocked}
                onClick={() => void save()}
              >
                {saving
                  ? t('settings.common.actions.saving')
                  : t('settings.common.actions.saveChanges')}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </SettingsSection>
  );
};

const ServerActions: React.FC<{
  native: boolean;
  busy: string | null;
  onCommand: (action: string, command: string, reload?: boolean) => void;
  server: McpAdapterServerSnapshot;
}> = ({ native, busy, onCommand, server }) => {
  const { t } = useI18n();
  const argument = mcpServerCommandArgument(server.name);
  const commandUnsupported = argument === null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {!server.disabled ? (
          <Button type="button" variant="outline" size="xs" disabled={busy !== null || commandUnsupported} onClick={() => onCommand('reconnect', `/mcp reconnect ${argument}`)} className="!font-normal">
            {t('settings.varin.mcp.actions.reconnect')}
          </Button>
        ) : null}
        {server.status === 'needs-auth' ? (
          <Button type="button" size="xs" disabled={busy !== null || commandUnsupported} onClick={() => onCommand('authorize', native ? `/mcp login ${argument}` : `/mcp-auth ${argument}`)} className="!font-normal">
            {t('settings.varin.mcp.actions.authorize')}
          </Button>
        ) : null}
        {!server.disabled ? (
          <Button type="button" variant="ghost" size="xs" disabled={busy !== null || commandUnsupported} onClick={() => onCommand('logout', `/mcp logout ${argument}`)} className="!font-normal text-muted-foreground">
            {t('settings.varin.mcp.actions.logout')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" disabled={busy !== null || commandUnsupported} onClick={() => onCommand(server.disabled ? 'enable' : 'disable', `/mcp ${server.disabled ? 'enable' : 'disable'} ${argument}`, !native)} className="!font-normal text-muted-foreground">
          {server.disabled
            ? t('settings.varin.mcp.actions.enable')
            : t('settings.varin.mcp.actions.disable')}
        </Button>
      </div>
      {commandUnsupported ? (
        <p className="typography-micro text-[var(--status-warning)]">
          {t('settings.varin.mcp.runtime.commandNameUnsupported')}
        </p>
      ) : null}
    </div>
  );
};

export const McpPage: React.FC = () => {
  const { t } = useI18n();
  const { runtimeTarget, targetKey } = useResourceRuntimeTarget();
  const catalogState = useMcpCatalogState();
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const extensionState = usePiSessionStore((state) => {
    const id = state.currentSessionId;
    return id ? state.records[id]?.extensionStates[MCP_ADAPTER_STATUS_CHANNEL] : undefined;
  });
  const executeCommand = usePiSessionStore((state) => state.executeCommand);
  const status = React.useMemo(() => parseMcpAdapterStatus(extensionState), [extensionState]);
  const [commandAction, setCommandAction] = React.useState<string | null>(null);
  const snapshot = catalogState.targetKey === targetKey ? catalogState.snapshot : null;
  const catalog = snapshot?.catalog;
  const selectedServerName = catalogState.selection.kind === 'server'
    ? catalogState.selection.name
    : undefined;
  const selectedServer = selectedServerName
    ? catalog?.servers.find((server) => server.name === selectedServerName)
    : undefined;
  const liveServer = selectedServer
    ? status?.servers.find((server) => server.name === selectedServer.name)
    : undefined;

  React.useEffect(() => {
    if (
      !catalogState.loading
      && (
        catalogState.targetKey !== targetKey
        || (catalogState.targetKey === targetKey && !catalogState.snapshot && !catalogState.error)
      )
    ) {
      void refreshMcpCatalog(runtimeTarget, targetKey);
    }
  }, [catalogState.error, catalogState.loading, catalogState.snapshot, catalogState.targetKey, runtimeTarget, targetKey]);

  const runCommand = React.useCallback(async (action: string, command: string, reload = false) => {
    if (!currentSessionId) return;
    setCommandAction(action);
    try {
      await executeCommand(currentSessionId, command);
      if (reload) await executeCommand(currentSessionId, '/reload');
    } catch (error) {
      console.error(`Failed to execute Pi MCP command ${command}:`, error);
      toast.error(error instanceof Error ? error.message : t('settings.varin.mcp.toast.commandFailed'));
    } finally {
      setCommandAction(null);
    }
  }, [currentSessionId, executeCommand, t]);

  const title = selectedServer?.name
    ?? (catalogState.selection.kind === 'new'
      ? t('settings.varin.mcp.structured.addServer')
      : t('settings.varin.mcp.config.title'));

  return (
    <SettingsPageLayout
      title={title}
      showSaveStatus={false}
      headerEnd={currentSessionId ? (
        <Button type="button" variant="outline" size="xs" disabled={commandAction !== null} onClick={() => void runCommand('panel', '/mcp')} className="!font-normal">
          {t('settings.varin.mcp.actions.openPanel')}
        </Button>
      ) : undefined}
    >
      {!catalog ? (
        <SettingsSection
          settingsItem="mcp.runtime"
          divider={false}
        >
          <div className={cn(
            'rounded-lg border px-4 py-6 text-center typography-meta',
            snapshot?.provider.state === 'degraded' || snapshot?.provider.state === 'incompatible'
              ? 'border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 text-[var(--status-warning)]'
              : 'border-border/60 text-muted-foreground',
          )}>
            {catalogState.loading
              ? <Icon name="loader-4" className="mx-auto size-5 animate-spin" />
              : catalogState.error
                ?? snapshot?.provider.issue
                ?? t('settings.varin.mcp.runtime.noStatus')}
          </div>
        </SettingsSection>
      ) : (
        <>
          {selectedServer ? (
            <SettingsSection
              title={t('settings.varin.mcp.runtime.title')}
              settingsItem="mcp.runtime"
            >
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="typography-ui-label text-foreground">{selectedServer.name}</code>
                  {liveServer ? (
                    <McpServerStatusBadge status={liveServer.status} />
                  ) : null}
                </div>
                <div className="space-y-1 typography-meta text-muted-foreground">
                  <p>{t(transportLabelKey(selectedServer.transport.kind) as never)}</p>
                  {selectedServer.transport.command ? <p className="break-all font-mono typography-micro">{selectedServer.transport.command}</p> : null}
                  {selectedServer.transport.url ? <p className="break-all font-mono typography-micro">{selectedServer.transport.url}</p> : null}
                  {selectedServer.transport.socket ? <p className="break-all font-mono typography-micro">{selectedServer.transport.socket}</p> : null}
                  {liveServer ? <p>{t('settings.varin.mcp.runtime.serverCounts', { tools: liveServer.toolCount, resources: liveServer.resourceCount ?? 0 })}</p> : null}
                </div>
                {liveServer && currentSessionId ? (
                  <ServerActions native={snapshot?.provider.owner === 'native'} busy={commandAction} onCommand={(action, command, reload) => void runCommand(`${action}:${liveServer.name}`, command, reload)} server={liveServer} />
                ) : null}
              </div>
            </SettingsSection>
          ) : null}

          <McpConfigEditor
            native={snapshot?.provider.owner === 'native'}
            mode={catalogState.selection.kind}
            runtimeTarget={runtimeTarget}
            targetKey={targetKey}
            refreshRevision={catalogState.catalogRevision}
            sources={catalog.sources}
            preferredServerName={selectedServer?.name}
          />
        </>
      )}
    </SettingsPageLayout>
  );
};
