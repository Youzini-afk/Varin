export type TerminalSessionOwner = "user" | "harness" | "agent";

export interface TerminalProcess {
  kill(signal?: NodeJS.Signals): void;
  native?: boolean;
  terminate?(force?: boolean): Promise<void>;
  completion?: Promise<void>;
  /** Close only this projection of a retained job. */
  detach?(): Promise<void>;
  onData(handler: (data: string) => void): { dispose?(): void };
  onExit(handler: (event: { exitCode: number | null; signal: number }) => void): { dispose?(): void };
  pid?: number | undefined;
  resize(cols: number, rows: number): void | Promise<void>;
  write(data: string, operationId?: string): void | Promise<void>;
}

export interface AdoptTerminalSessionInput {
  sessionId: string;
  cwd: string;
  process: TerminalProcess;
  identity: { threadId: string; branchId: string; runId: string; operationId: string; processId: string; kernelEpoch: string };
}

export interface TerminalSpawnSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CreateTerminalSessionInput {
  sessionId?: string;
  cwd: string;
  cols?: number;
  rows?: number;
  shell?: string;
  loginShell?: boolean;
  themeMode?: "dark" | "light";
  terminalBackground?: string;
  terminalForeground?: string;
  owner?: Exclude<TerminalSessionOwner, 'agent'>;
  spawn?: TerminalSpawnSpec;
  registerProcessWriter?: boolean;
  retainWhenDetached?: boolean;
}

export interface TerminalCommandRecord {
  command: string;
  commandId: string;
  cwd?: string;
  endedAt: number;
  exitCode: number;
  integration: "osc-633";
  owner: TerminalSessionOwner;
  startedAt?: number;
  terminalId: string;
}

export interface TerminalHandle {
  readonly id: string;
  readonly cwd: string;
  readonly status: "exited" | "running" | "error";
  write(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  onData(handler: (data: string) => void): { dispose(): void };
  onCommand(handler: (event: TerminalCommandRecord) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number | null; signal: number }) => void): { dispose(): void };
  /** Authority loss is not an exit event; the writer remains protected. */
  onError?(handler: (error: Error) => void): { dispose(): void };
  waitForExit(): Promise<{ exitCode: number | null; signal: number | null }>;
  terminate(force?: boolean): Promise<void>;
  destroy(): Promise<void>;
}

export interface TerminalSessionInfo {
  cwd: string;
  id: string;
  integration: "not-observed" | "ready";
  owner: TerminalSessionOwner;
  retainWhenDetached: boolean;
  status: "exited" | "running" | "error";
  processIdentity?: AdoptTerminalSessionInput['identity'];
}

export interface TerminalSessionApi {
  attachTerminalSession(id: string): TerminalHandle | null;
  createTerminalSession(input: CreateTerminalSessionInput): Promise<TerminalHandle>;
  adoptTerminalSession?(input: AdoptTerminalSessionInput): Promise<TerminalHandle>;
  inspectSession(id: string): TerminalSessionInfo | null;
  subscribeCommands(handler: (event: TerminalCommandRecord) => void): { dispose(): void };
}
