import React from 'react';
import type { JsonValue } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import {
  asJsonObject,
  readJsonPath,
  validFiniteNumber,
  validStringArray,
  type JsonObject,
} from '@/components/sections/plugin-settings/plugin-config-model';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import {
  mcpServerTransport,
  mcpSourceBooleanState,
  parseMcpConfigObject,
  removeMcpConfigValue,
  setMcpConfigValue,
  switchMcpServerTransport,
  updateMcpServerUrl,
  type McpServerTransportMode,
} from './mcp-config-model';

interface McpStructuredConfigEditorProps {
  native?: boolean;
  project?: boolean;
  content: string;
  disabled: boolean;
  mode: 'new' | 'server' | 'settings';
  onChange: (content: string) => void;
  onCreatedServerNameChange?: (name: string | null) => void;
  serverName?: string;
}

interface SourceFieldProps {
  className?: string;
  disabled: boolean;
  document: JsonObject;
  info?: React.ReactNode;
  label: string;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  path: readonly string[];
}

interface SourceSelectOption {
  label: React.ReactNode;
  value: boolean | string;
}

const SUBGROUP_CLASS = 'border-t border-border/60 pt-5';

const sourceOptionKey = (value: boolean | string): string => (
  typeof value === 'boolean' ? `boolean:${String(value)}` : `string:${value}`
);

const SourceOptionalBooleanField: React.FC<SourceFieldProps> = ({
  className,
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  path,
}) => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const value = mcpSourceBooleanState(document, path);
  const selectedLabel = text(`settings.varin.mcp.structured.sourceValue.${value === 'not-set' ? 'notSet' : value}`);

  return (
    <SettingsFieldRow label={label} info={info} className={className}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'not-set') onRemove(path);
          else onSet(path, next === 'enabled');
        }}
      >
        <SelectTrigger
          size="settings"
          className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          aria-label={label}
        >
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="not-set">
            {text('settings.varin.mcp.structured.sourceValue.notSet')}
          </SelectItem>
          <SelectItem value="enabled">
            {text('settings.varin.mcp.structured.sourceValue.enabled')}
          </SelectItem>
          <SelectItem value="disabled">
            {text('settings.varin.mcp.structured.sourceValue.disabled')}
          </SelectItem>
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};

const SourceOptionalSelectField: React.FC<SourceFieldProps & {
  options: readonly SourceSelectOption[];
}> = ({
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  options,
  path,
}) => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const raw = readJsonPath(document, path);
  const selected = options.find((option) => option.value === raw);
  const unsupported = raw !== undefined && selected === undefined;
  const value = selected
    ? sourceOptionKey(selected.value)
    : unsupported
      ? 'unsupported'
      : 'not-set';
  const selectedLabel = selected?.label ?? text(
    unsupported
      ? 'settings.varin.pluginSettings.field.unsupportedValue'
      : 'settings.varin.mcp.structured.sourceValue.notSet',
  );

  return (
    <SettingsFieldRow label={label} info={info}>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'not-set') {
            onRemove(path);
            return;
          }
          const option = options.find((entry) => sourceOptionKey(entry.value) === next);
          if (option) onSet(path, option.value);
        }}
      >
        <SelectTrigger
          size="settings"
          className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          aria-label={label}
        >
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {unsupported ? (
            <SelectItem value="unsupported" disabled>
              {text('settings.varin.pluginSettings.field.unsupportedValue')}
            </SelectItem>
          ) : null}
          <SelectItem value="not-set">
            {text('settings.varin.mcp.structured.sourceValue.notSet')}
          </SelectItem>
          {options.map((option) => (
            <SelectItem key={sourceOptionKey(option.value)} value={sourceOptionKey(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
};

const SourceStringField: React.FC<SourceFieldProps & {
  placeholder?: string;
}> = ({
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
}) => {
  const raw = readJsonPath(document, path);
  return (
    <SettingsFieldRow label={label} info={info} controlClassName="w-full max-w-[24rem]">
      <Input
        value={typeof raw === 'string' ? raw : ''}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          if (next) onSet(path, next);
          else onRemove(path);
        }}
        className="min-w-0 flex-1"
      />
    </SettingsFieldRow>
  );
};

const SourceStringListField: React.FC<SourceFieldProps & {
  placeholder?: string;
}> = ({
  disabled,
  document,
  info,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
}) => {
  const raw = readJsonPath(document, path);
  const values = typeof raw === 'string' ? [raw] : validStringArray(raw) ?? [];
  return (
    <SettingsFieldRow
      label={label}
      info={info}
      alignEnd={false}
      controlClassName="w-full max-w-[24rem] items-start"
    >
      <Textarea
        value={values.join('\n')}
        disabled={disabled}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
          if (next.length > 0) onSet(path, next);
          else onRemove(path);
        }}
        className="min-h-20 min-w-0 flex-1 font-mono"
      />
    </SettingsFieldRow>
  );
};

const SourceKeyValueField: React.FC<SourceFieldProps & {
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
}> = ({
  addLabel,
  disabled,
  document,
  keyPlaceholder,
  label,
  onRemove,
  onSet,
  path,
  valuePlaceholder,
}) => {
  const value = asJsonObject(readJsonPath(document, path));
  const entries = Object.entries(value).filter((entry): entry is [string, string] => (
    typeof entry[1] === 'string'
  ));
  const [key, setKey] = React.useState('');
  const [entryValue, setEntryValue] = React.useState('');
  const [revealed, setRevealed] = React.useState<ReadonlySet<string>>(() => new Set());
  const add = (): void => {
    const nextKey = key.trim();
    if (!nextKey) return;
    onSet([...path, nextKey], entryValue);
    setKey('');
    setEntryValue('');
  };

  return (
    <div className="space-y-3">
      <div className="typography-ui-label text-foreground">{label}</div>
      {entries.map(([entryKey, value]) => (
        <div key={entryKey} className="flex min-w-0 items-center gap-2">
          <Input value={entryKey} readOnly className="min-w-0 flex-1 font-mono" />
          <div className="relative min-w-0 flex-[1.5]">
            <Input
              value={value}
              type={revealed.has(entryKey) ? 'text' : 'password'}
              disabled={disabled}
              onChange={(event) => onSet([...path, entryKey], event.target.value)}
              className="w-full pr-9 font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setRevealed((current) => {
                const next = new Set(current);
                if (next.has(entryKey)) next.delete(entryKey);
                else next.add(entryKey);
                return next;
              })}
              className="absolute right-0 top-0 size-9 text-muted-foreground"
            >
              <Icon name={revealed.has(entryKey) ? 'eye-off' : 'eye'} className="size-4" />
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={() => onRemove([...path, entryKey])}
            className="size-8 shrink-0 text-muted-foreground"
          >
            ×
          </Button>
        </div>
      ))}
      <div className="flex min-w-0 items-center gap-2">
        <Input
          value={key}
          disabled={disabled}
          placeholder={keyPlaceholder}
          onChange={(event) => setKey(event.target.value)}
          className="min-w-0 flex-1 font-mono"
        />
        <Input
          value={entryValue}
          type="password"
          disabled={disabled}
          placeholder={valuePlaceholder}
          onChange={(event) => setEntryValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            add();
          }}
          className="min-w-0 flex-[1.5] font-mono"
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || !key.trim()} onClick={add}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
};

const SourceToolExposureField: React.FC<SourceFieldProps> = (props) => {
  const { t } = useI18n();
  const [pattern, setPattern] = React.useState('');
  const entries = asJsonObject(readJsonPath(props.document, props.path));
  const options = ['codemode', 'deferred', 'direct', 'hidden'].map(value => ({
    value, label: t(`settings.varin.mcp.native.exposure.${value}` as never),
  }));
  const add = () => {
    const name = pattern.trim();
    if (!name || props.disabled || Object.hasOwn(entries, name)) return;
    props.onSet([...props.path, name], 'codemode');
    setPattern('');
  };
  return <div className="space-y-3">
    <div className="typography-ui-label text-foreground">{props.label}</div>
    {Object.keys(entries).map(name => (
      <SourceOptionalSelectField key={name} {...props} label={name}
        path={[...props.path, name]} options={options} />
    ))}
    <div className="flex gap-2">
      <Input value={pattern} disabled={props.disabled} placeholder="read_*"
        aria-label={t('settings.varin.mcp.native.toolPattern')}
        onChange={event => setPattern(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      <Button type="button" variant="outline" size="sm" onClick={add}
        disabled={props.disabled || !pattern.trim() || Object.hasOwn(entries, pattern.trim())}>
        {t('settings.varin.mcp.structured.add')}
      </Button>
    </div>
  </div>;
};

const SourceOptionalNumberField: React.FC<SourceFieldProps & {
  min?: number;
  unit?: React.ReactNode;
}> = ({
  disabled,
  document,
  info,
  label,
  min,
  onRemove,
  onSet,
  path,
  unit,
}) => {
  const { t } = useI18n();
  const value = validFiniteNumber(readJsonPath(document, path));
  return (
    <SettingsFieldRow label={label} info={info} controlClassName="w-full max-w-[24rem]">
      <NumberInput
        value={value}
        fallbackValue={min}
        disabled={disabled}
        min={min}
        emptyLabel={t('settings.varin.mcp.structured.sourceValue.notSet' as never)}
        placeholder={t('settings.varin.mcp.structured.sourceValue.notSet' as never)}
        aria-label={label}
        onClear={() => onRemove(path)}
        onValueChange={(next) => onSet(path, next)}
        containerClassName="w-36"
      />
      {unit ? <span className="typography-meta text-muted-foreground">{unit}</span> : null}
    </SettingsFieldRow>
  );
};

export const McpStructuredConfigEditor: React.FC<McpStructuredConfigEditorProps> = ({
  native = false,
  project = false,
  content,
  disabled,
  mode,
  onChange,
  onCreatedServerNameChange,
  serverName,
}) => {
  const { t } = useI18n();
  const text = (key: string): string => t(key as never);
  const document = React.useMemo(() => parseMcpConfigObject(content), [content]);
  const [newServerName, setNewServerName] = React.useState('');
  const [createdServerName, setCreatedServerName] = React.useState('');
  const selectedName = mode === 'server' && serverName
    ? serverName
    : mode === 'new'
      ? createdServerName
      : '';

  React.useEffect(() => {
    if (mode === 'new') return;
    setNewServerName('');
    setCreatedServerName('');
    onCreatedServerNameChange?.(null);
  }, [mode, onCreatedServerNameChange]);

  React.useEffect(() => {
    if (mode !== 'new' || !createdServerName) return;
    const servers = asJsonObject(readJsonPath(document, ['mcpServers']));
    if (Object.prototype.hasOwnProperty.call(servers, createdServerName)) return;
    setCreatedServerName('');
    onCreatedServerNameChange?.(null);
  }, [createdServerName, document, mode, onCreatedServerNameChange]);

  const setValue = React.useCallback((path: readonly string[], value: JsonValue) => {
    onChange(setMcpConfigValue(content, path, value));
  }, [content, onChange]);
  const removeValue = React.useCallback((path: readonly string[]) => {
    let next = removeMcpConfigValue(content, path);
    if (native && path.at(-2) === 'auth' && path.at(-1) === 'provider') {
      const parent = path.slice(0, -1);
      if (!Object.keys(asJsonObject(readJsonPath(parseMcpConfigObject(next), parent))).length) next = removeMcpConfigValue(next, parent);
    }
    onChange(next);
  }, [content, native, onChange]);
  const sourceFields = {
    disabled,
    document,
    onRemove: removeValue,
    onSet: setValue,
  };
  const serverPath = ['mcpServers', selectedName] as const;
  const server = asJsonObject(readJsonPath(document, serverPath));
  const transport = selectedName
    ? mcpServerTransport(document, selectedName)
    : 'unconfigured';
  const outputGuard = readJsonPath(document, ['settings', 'outputGuard']);
  const sampling = readJsonPath(document, ['settings', 'sampling']);
  const samplingAutoApprove = readJsonPath(document, ['settings', 'samplingAutoApprove']);
  const newServerExists = Boolean(
    newServerName.trim()
    && Object.prototype.hasOwnProperty.call(
      asJsonObject(readJsonPath(document, ['mcpServers'])),
      newServerName.trim(),
    )
  );

  const addServer = (): void => {
    const name = newServerName.trim();
    if (!name) return;
    const servers = asJsonObject(readJsonPath(document, ['mcpServers']));
    if (Object.prototype.hasOwnProperty.call(servers, name)) return;
    onChange(setMcpConfigValue(content, ['mcpServers', name], {}));
    setCreatedServerName(name);
    onCreatedServerNameChange?.(name);
    setNewServerName('');
  };

  const removeServer = (): void => {
    if (!selectedName) return;
    onChange(removeMcpConfigValue(content, serverPath));
    if (mode === 'new') {
      setCreatedServerName('');
      onCreatedServerNameChange?.(null);
    }
  };

  const selectTransport = (next: McpServerTransportMode): void => {
    if (!selectedName) return;
    let updated = switchMcpServerTransport(content, selectedName, next);
    if (native) updated = next === 'unconfigured'
      ? removeMcpConfigValue(updated, [...serverPath, 'type'])
      : setMcpConfigValue(updated, [...serverPath, 'type'], next);
    if (native && next === 'unconfigured') {
      for (const field of ['timeout', 'description']) updated = removeMcpConfigValue(updated, [...serverPath, field]);
    }
    onChange(updated);
  };

  const setUrl = (url: string): void => {
    if (!selectedName) return;
    if (native) { setValue([...serverPath, 'url'], url); return; }
    let next = updateMcpServerUrl(content, selectedName, url);
    if (!url) next = removeMcpConfigValue(next, [...serverPath, 'url']);
    onChange(next);
  };

  return (
    <div className="space-y-5">
      {mode !== 'settings' ? <SettingsControlGroup contentClassName="space-y-5">
        {mode === 'new' ? <SettingsFieldRow
          label={text('settings.varin.mcp.structured.serverName')}
        >
          <Input
            value={newServerName}
            disabled={disabled}
            aria-label={text('settings.varin.mcp.structured.serverName')}
            placeholder="github"
            onChange={(event) => setNewServerName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              addServer();
            }}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || !newServerName.trim() || newServerExists}
            onClick={addServer}
          >
            {text('settings.varin.mcp.structured.addServer')}
          </Button>
        </SettingsFieldRow> : null}

        {selectedName ? (
          <div className="space-y-5 border-t border-border/60 pt-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <code className="block truncate typography-ui-label text-foreground">{selectedName}</code>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={removeServer}
                className="shrink-0 !font-normal text-[var(--status-error)]"
              >
                {text('settings.common.actions.delete')}
              </Button>
            </div>

            <SettingsFieldRow
              label={text('settings.varin.mcp.structured.transport')}
            >
              <Select value={transport} disabled={disabled} onValueChange={selectTransport}>
                <SelectTrigger
                  size="settings"
                  className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
                  aria-label={text('settings.varin.mcp.structured.transport')}
                >
                  <SelectValue>
                    {text(`settings.varin.mcp.structured.transport.${transport === 'unconfigured'
                      ? 'inherited'
                      : transport === 'stdio'
                        ? 'localCommand'
                        : transport === 'socket'
                          ? 'localSocket'
                          : 'http'}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unconfigured">
                    {text('settings.varin.mcp.structured.transport.inherited')}
                  </SelectItem>
                  <SelectItem value="stdio">
                    {text('settings.varin.mcp.structured.transport.localCommand')}
                  </SelectItem>
                  <SelectItem value="http">
                    {text('settings.varin.mcp.structured.transport.http')}
                  </SelectItem>
                  {!native ? <SelectItem value="socket">
                    {text('settings.varin.mcp.structured.transport.localSocket')}
                  </SelectItem> : null}
                </SelectContent>
              </Select>
            </SettingsFieldRow>

            {transport === 'stdio' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <SourceStringField
                  {...sourceFields}
                  path={[...serverPath, 'command']}
                  label={text('settings.varin.mcp.structured.server.command')}
                  placeholder="npx"
                />
                <SourceStringListField
                  {...sourceFields}
                  path={[...serverPath, 'args']}
                  label={text('settings.varin.mcp.structured.server.arguments')}
                  placeholder={'-y\n@modelcontextprotocol/server-github'}
                />
                <SourceStringField
                  {...sourceFields}
                  path={[...serverPath, 'cwd']}
                  label={text('settings.varin.mcp.structured.server.workingDirectory')}
                  placeholder="path/to/working-directory"
                />
                <SourceKeyValueField
                  {...sourceFields}
                  path={[...serverPath, 'env']}
                  label={text('settings.varin.mcp.structured.server.environment')}
                  keyPlaceholder="API_KEY"
                  valuePlaceholder="value"
                  addLabel={text('settings.varin.mcp.structured.add')}
                />
              </div>
            ) : null}

            {transport === 'http' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <SettingsFieldRow
                  label={text('settings.varin.mcp.structured.server.url')}
                  controlClassName="w-full max-w-lg"
                >
                  <Input
                    value={typeof server.url === 'string' ? server.url : ''}
                    disabled={disabled}
                    aria-label={text('settings.varin.mcp.structured.server.url')}
                    placeholder="https://example.com/mcp"
                    onChange={(event) => setUrl(event.target.value)}
                    className="min-w-0 flex-1"
                  />
                </SettingsFieldRow>
                {!native ? <SourceOptionalSelectField
                  {...sourceFields}
                  path={[...serverPath, 'auth']}
                  label={text('settings.varin.mcp.structured.server.authentication')}
                  options={[
                    { value: 'oauth', label: text('settings.varin.mcp.structured.server.authentication.oauth') },
                    { value: 'bearer', label: text('settings.varin.mcp.structured.server.authentication.bearer') },
                    { value: false, label: text('settings.varin.mcp.structured.server.authentication.none') },
                  ]}
                /> : null}
                {!native ? <SourceStringField
                  {...sourceFields}
                  path={[...serverPath, 'bearerTokenEnv']}
                  label={text('settings.varin.mcp.structured.server.bearerTokenEnv')}
                  placeholder="MCP_TOKEN"
                /> : null}
                <SourceKeyValueField
                  {...sourceFields}
                  path={[...serverPath, 'headers']}
                  label={text('settings.varin.mcp.structured.server.headers')}
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer …"
                  addLabel={text('settings.varin.mcp.structured.add')}
                />
              </div>
            ) : null}

            {transport === 'socket' ? (
              <div className="space-y-4 border-t border-border/60 pt-4">
                <SourceStringField
                  {...sourceFields}
                  path={[...serverPath, 'socket']}
                  label={text('settings.varin.mcp.structured.server.socketPath')}
                  placeholder="~/.rmcp-servers/rmcp-mux/sockets/server.sock"
                />
                <p className="typography-meta text-[var(--status-warning)]">
                  {text('settings.varin.mcp.structured.server.socketWarning')}
                </p>
              </div>
            ) : null}

            {native ? <div className="space-y-4 border-t border-border/60 pt-4">
              <SourceOptionalBooleanField {...sourceFields} path={[...serverPath, 'enabled']}
                label={text('settings.varin.mcp.native.enabled')} />
              <SourceOptionalSelectField {...sourceFields} path={[...serverPath, 'exposure']}
                label={text('settings.varin.mcp.native.exposure')}
                options={['codemode', 'deferred', 'direct', 'hidden'].map(value => ({ value,
                  label: text(`settings.varin.mcp.native.exposure.${value}`) }))} />
              <SourceToolExposureField {...sourceFields} path={[...serverPath, 'toolExposure']}
                label={text('settings.varin.mcp.native.toolExposure')} />
              {transport !== 'unconfigured' ? <><SourceOptionalNumberField {...sourceFields} path={[...serverPath, 'timeout']}
                label={text('settings.varin.mcp.structured.server.requestTimeout')}
                min={0} unit={text('settings.varin.mcp.native.seconds')} />
              <SourceStringField {...sourceFields} path={[...serverPath, 'description']}
                label={text('settings.varin.mcp.native.description')} /></> : null}
              {transport === 'http' ? <>
                {!project ? <SourceStringField {...sourceFields} path={[...serverPath, 'auth', 'provider']}
                  label={text('settings.varin.mcp.native.authProvider')} /> : null}
                <SourceStringField {...sourceFields} path={[...serverPath, 'oauth', 'clientId']}
                  label="OAuth client ID" />
                <SourceStringField {...sourceFields} path={[...serverPath, 'oauth', 'scope']}
                  label="OAuth scope" />
              </> : null}
            </div> : <div className="space-y-4 border-t border-border/60 pt-4">
              <SourceOptionalNumberField
                {...sourceFields}
                path={[...serverPath, 'idleTimeout']}
                label={text('settings.varin.mcp.structured.server.idleTimeout')}
                min={0}
                unit={text('settings.varin.mcp.structured.unit.minutes')}
              />
              <SourceOptionalNumberField
                {...sourceFields}
                path={[...serverPath, 'requestTimeoutMs']}
                label={text('settings.varin.mcp.structured.server.requestTimeout')}
                min={0}
                unit={text('settings.varin.mcp.structured.unit.milliseconds')}
              />
              <SourceOptionalBooleanField
                {...sourceFields}
                path={[...serverPath, 'exposeResources']}
                label={text('settings.varin.mcp.structured.server.exposeResources')}
              />
              <SourceOptionalBooleanField
                {...sourceFields}
                path={[...serverPath, 'disabled']}
                label={text('settings.varin.mcp.structured.server.disabled')}
              />
            </div>}
          </div>
        ) : (
          <p className="typography-meta text-muted-foreground">
            {text('settings.varin.mcp.structured.noServers')}
          </p>
        )}
      </SettingsControlGroup> : null}

      {mode === 'settings' && native ? <SettingsControlGroup contentClassName="space-y-4">
        <SourceOptionalBooleanField {...sourceFields} path={['autoEnableCodemode']}
          label={text('settings.varin.mcp.native.autoEnableCodemode')} />
      </SettingsControlGroup> : null}

      {mode === 'settings' && !native ? <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={text('settings.varin.mcp.structured.behavior.title')}
        contentClassName="space-y-4"
      >
        <SourceStringListField
          {...sourceFields}
          path={['imports']}
          label={text('settings.varin.mcp.structured.behavior.imports')}
          placeholder={'cursor\nclaude-code\nclaude-desktop\ncodex\nopencode\nwindsurf\nvscode'}
        />
        <SourceOptionalSelectField
          {...sourceFields}
          path={['settings', 'toolPrefix']}
          label={text('settings.varin.mcp.structured.behavior.toolPrefix')}
          options={[
            { value: 'server', label: text('settings.varin.mcp.structured.behavior.toolPrefix.server') },
            { value: 'short', label: text('settings.varin.mcp.structured.behavior.toolPrefix.short') },
            { value: 'mcp', label: text('settings.varin.mcp.structured.behavior.toolPrefix.mcp') },
            { value: 'none', label: text('settings.varin.mcp.structured.behavior.toolPrefix.none') },
          ]}
        />
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'showStatusIcon']}
          label={text('settings.varin.mcp.structured.behavior.statusIcon')}
        />
        <SourceOptionalSelectField
          {...sourceFields}
          path={['settings', 'mcpFooterStatus']}
          label={text('settings.varin.mcp.structured.behavior.footerStatus')}
          options={[
            { value: 'full', label: text('settings.varin.mcp.structured.behavior.footerStatus.full') },
            { value: 'compact', label: text('settings.varin.mcp.structured.behavior.footerStatus.compact') },
            { value: 'off', label: text('settings.varin.mcp.structured.behavior.footerStatus.off') },
          ]}
        />
        <SourceOptionalNumberField
          {...sourceFields}
          path={['settings', 'idleTimeout']}
          label={text('settings.varin.mcp.structured.behavior.idleTimeout')}
          min={0}
          unit={text('settings.varin.mcp.structured.unit.minutes')}
        />
        <SourceOptionalNumberField
          {...sourceFields}
          path={['settings', 'requestTimeoutMs']}
          label={text('settings.varin.mcp.structured.behavior.requestTimeout')}
          min={0}
          unit={text('settings.varin.mcp.structured.unit.milliseconds')}
        />
      </SettingsControlGroup> : null}

      {mode === 'settings' && !native ? <SettingsControlGroup
        className={SUBGROUP_CLASS}
        title={text('settings.varin.mcp.structured.interaction.title')}
        contentClassName="space-y-4"
      >
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'autoAuth']}
          label={text('settings.varin.mcp.structured.interaction.autoAuth')}
        />
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'sampling']}
          label={text('settings.varin.mcp.structured.interaction.sampling')}
        />
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'samplingAutoApprove']}
          label={text('settings.varin.mcp.structured.interaction.samplingAutoApprove')}
        />
        {sampling === true && samplingAutoApprove === true ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {text('settings.varin.mcp.structured.interaction.samplingAutoApprove.warning')}
          </p>
        ) : null}
        <SourceOptionalBooleanField
          {...sourceFields}
          path={['settings', 'elicitation']}
          label={text('settings.varin.mcp.structured.interaction.elicitation')}
        />
        {typeof outputGuard === 'object' && outputGuard !== null && !Array.isArray(outputGuard) ? (
          <p className="typography-meta text-muted-foreground">
            {text('settings.varin.mcp.structured.outputGuardAdvanced')}
          </p>
        ) : (
          <SourceOptionalBooleanField
            {...sourceFields}
            path={['settings', 'outputGuard']}
            label={text('settings.varin.mcp.structured.interaction.outputGuard')}
          />
        )}
      </SettingsControlGroup> : null}
    </div>
  );
};
