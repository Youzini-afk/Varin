export interface TerminalWorkspaceSource {
  selection: Extract<import('@varin/application-client').ProjectSourceSelection, { mode: 'native_workspace' }>;
  canonicalRoot: string;
}

export type TerminalSessionOwner = "user" | "harness" | "agent";

export interface TerminalProcess {
  kill(signal?: NodeJS.Signals): void;
  native?: boolean;
  terminate?(force?: boolean): Promise<void>;
  completion?: Promise<void>;
  /** Close only this projection of a retained job. */
  detach?(): Promise<void>;
  onData(handler: (data: string, delivery?: { replay: boolean }) => void): { dispose?(): void };
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
  /** Trusted target-owner provenance, fixed with the original session identity. */
  source?: TerminalWorkspaceSource;
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
  write(data: string, operationId?:string): void | Promise<void>;
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
  source?: TerminalWorkspaceSource;
  cols?:number;rows?:number;
  cwd: string;
  id: string;
  integration: "not-observed" | "ready";
  /** Oversized OSC frames discarded in this terminal generation, not completed commands. */
  discardedIntegrationFrames?: number;
  owner: TerminalSessionOwner;
  retainWhenDetached: boolean;
  status: "exited" | "running" | "error";
  processIdentity?: AdoptTerminalSessionInput['identity'];
}

export interface TerminalSessionApi {
  retireTerminalSession?(id:string):Promise<void>;
  readTerminalSnapshot?(id:string):Record<string,unknown>|null;
  observeTerminalSession?(id:string,listener:(frame:Record<string,unknown>)=>void):{dispose():void}|null;
  updateTerminalAppearance?(id:string,appearance:{themeMode?:"dark"|"light";terminalBackground?:string;terminalForeground?:string}):void;
  attachTerminalSession(id: string): TerminalHandle | null;
  createTerminalSession(input: CreateTerminalSessionInput): Promise<TerminalHandle>;
  adoptTerminalSession?(input: AdoptTerminalSessionInput): Promise<TerminalHandle>;
  inspectSession(id: string): TerminalSessionInfo | null;
  subscribeCommands(handler: (event: TerminalCommandRecord) => void): { dispose(): void };
}
