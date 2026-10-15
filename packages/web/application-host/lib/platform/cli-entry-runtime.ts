import { createProcessRestart } from './process-restart.js';
import type {
  ParsedServeCliArgs,
  ParseServeCliOptionsInput,
  StartWebUiServerOptions,
  WebUiServerController,
} from '../../public-contract.js';

export interface CliEntryDependencies {
  cloudflareProvider: string;
  currentFilename: string;
  defaultPort: number;
  managedLocalMode: string;
  parseServeCliOptions(input: ParseServeCliOptionsInput): ParsedServeCliArgs;
  process: Pick<NodeJS.Process, 'argv' | 'env' | 'exit'>;
  setExitOnShutdown(value: boolean): void;
  startServer(options: StartWebUiServerOptions): Promise<unknown>;
}

export const runCliEntryIfMain = (dependencies: CliEntryDependencies): void => {
  const {
    process,
    currentFilename,
    parseServeCliOptions,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
    setExitOnShutdown,
    startServer,
  } = dependencies;

  const isCliExecution = process.argv[1] === currentFilename;
  if (!isCliExecution) {
    return;
  }

  const cliOptions = parseServeCliOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
  });

  setExitOnShutdown(true);
  let controller: WebUiServerController | undefined;
  const restartApplicationHost = createProcessRestart({ stop: async () => {
    if (!controller) throw new Error('Application Host is still starting');
    await controller.stop({ exitProcess: false });
  }, exit: code => process.exit(code) });
  startServer({
    restartApplicationHost,
    port: cliOptions.port,
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword,
    apiOnly: cliOptions.apiOnly,
  }).then(value => { controller = value as WebUiServerController; }).catch((error: unknown) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
};
