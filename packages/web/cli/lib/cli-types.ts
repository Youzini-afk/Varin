export interface CliNotice {
  code?: string | undefined;
  level: 'error' | 'info' | 'warning';
  message: string;
}

export interface CliOptions extends Record<string, unknown> {
  all?: boolean | undefined;
  apiOnly?: boolean | undefined;
  branch?: string | undefined;
  configPath?: string | null | undefined;
  connectTtl?: string | undefined;
  cron?: string | undefined;
  daily?: string | undefined;
  directory?: string | undefined;
  disabled?: boolean | undefined;
  dryRun?: boolean | undefined;
  envSnapshot?: boolean | undefined;
  explicitPort?: boolean | undefined;
  explicitQr?: boolean | undefined;
  explicitUiPassword?: boolean | undefined;
  follow?: boolean | undefined;
  force?: boolean | undefined;
  foreground?: boolean | undefined;
  goal?: boolean | undefined;
  goalTokenBudget?: string | number | undefined;
  headers?: HeadersInit | undefined;
  host?: string | undefined;
  hostname?: string | undefined;
  json?: boolean | undefined;
  lan?: boolean | undefined;
  last?: boolean | undefined;
  lastAssistant?: boolean | undefined;
  limit?: number | string | undefined;
  lines?: number | undefined;
  message?: string | undefined;
  method?: string | undefined;
  mode?: string | undefined;
  model?: string | undefined;
  name?: string | undefined;
  noQr?: boolean | undefined;
  plain?: boolean | undefined;
  port?: number | undefined;
  profile?: string | undefined;
  project?: string | undefined;
  prompt?: string | undefined;
  provider?: string | undefined;
  qr?: boolean | undefined;
  quiet?: boolean | undefined;
  relay?: boolean | undefined;
  role?: string | undefined;
  server?: string | undefined;
  thread?: string | undefined;
  key?: string | undefined;
  sourceMode?: string | undefined;
  sessionTtl?: string | undefined;
  setUpstream?: boolean | undefined;
  showSecrets?: boolean | undefined;
  startRef?: string | undefined;
  suppressQuietOutput?: boolean | undefined;
  suppressStartupSummary?: boolean | undefined;
  suppressUiPasswordWarning?: boolean | undefined;
  suppressUnsafePortWarning?: boolean | undefined;
  task?: string | undefined;
  thinking?: string | undefined;
  time?: string | undefined;
  timeout?: string | number | undefined;
  timeoutMs?: number | undefined;
  timezone?: string | undefined;
  title?: string | undefined;
  token?: string | undefined;
  tokenFile?: string | undefined;
  tokenStdin?: boolean | undefined;
  trustProject?: boolean | undefined;
  uiPassword?: string | null | undefined;
  wait?: boolean | undefined;
  weekly?: string | undefined;
  withStatus?: boolean | undefined;
  body?: BodyInit | null | undefined;
}

export type ServeCommand = (options: CliOptions) => Promise<number | void>;
export type StopCommand = (options: CliOptions) => Promise<void>;
export type CancelCleanup = () => void | Promise<void>;
export type ForegroundShutdown = (signal?: NodeJS.Signals) => Promise<void>;

export const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);
