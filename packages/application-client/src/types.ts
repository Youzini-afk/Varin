import type { AgentInputContext, PiRuntimeSnapshot, WorkFocusId } from '@varin/protocol';
import type { WorktreeMetadata, DraftStarterRef, FileEditorSettingsPatch } from './ui-dto.js';
import type {
  VarinExtensionActualState,
  VarinExtensionAssetPayload,
  VarinExtensionAssetRequest,
  VarinExtensionCandidateCapabilityReviewRequest,
  VarinExtensionCapabilityReviewRequest,
  VarinExtensionCandidateSelectionRequest,
  VarinExtensionCandidatePreparationResult,
  VarinExtensionCatalogAvailability,
  VarinExtensionCatalogSnapshot,
  VarinExtensionHostStateSnapshot,
  VarinExtensionHostStateWaitRequest,
  VarinExtensionManagedEntrypointPayload,
  VarinExtensionManagedEntrypointRequest,
  VarinExtensionLocalSourceReloadRequest,
  VarinExtensionLocalSourceReloadResult,
  VarinExtensionPackageInstallRequest,
  VarinExtensionRemoveRequest,
  VarinExtensionServiceInvocationRequest,
  VarinExtensionServiceRoutingRuleRemoveRequest,
  VarinExtensionServiceRoutingRuleUpdateRequest,
  VarinExtensionServiceRoutingSnapshot,
  VarinExtensionServiceSelectionRequest,
  VarinWorkbenchLayoutUpdateRequest,
  VarinWorkbenchProfileRemoveRequest,
  VarinWorkbenchProfileApplyRequest,
  VarinWorkbenchProfileSelectionRequest,
  VarinWorkbenchProfileSnapshot,
  VarinWorkbenchProfileUpsertRequest,
  JsonValue,
} from '@varin/extension-contract';

export type RuntimePlatform = 'web' | 'desktop';

export interface RuntimeDescriptor {
  platform: RuntimePlatform;

  isDesktop: boolean;

  label?: string;
}

export interface Subscription {

  close: () => void;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited' | 'error';
}

export type TerminalShell = 'auto' | 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'dash' | 'ksh' | 'nu';

export interface TerminalShellOption {
  id: TerminalShell;
  name: string;
  supportsLogin: boolean;
}

export interface TerminalStreamEvent {
  type: 'snapshot' | 'data' | 'exit' | 'reconnecting';
  sequence?: number;
  data?: string;
  replayData?: string;
  status?: 'running' | 'exited' | 'error';
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;

  runtime?: 'node' | 'bun';
  ptyBackend?: string;
}

export interface TerminalError extends Error {
  code?: string;
}

export interface CreateTerminalOptions {
  cwd?: string;
  workspacePath?: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
  shell?: TerminalShell;
  loginShell?: boolean;
}

export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: TerminalError, fatal?: boolean) => void;
}

export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

export interface TerminalAPI {
  listShells?(): Promise<TerminalShellOption[]>;
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers): Subscription;
  sendInput(sessionId: string, input: string): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  updateAppearance?(sessionId: string, appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>): Promise<void>;
  close(sessionId: string): Promise<void>;
  restartSession?(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
}

export interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitMergeInProgress {
  /** Short SHA of MERGE_HEAD */
  head: string;
  /** First line of MERGE_MSG */
  message: string;
}

export interface GitRebaseInProgress {
  /** Branch name being rebased */
  headName: string;
  /** Short SHA of the onto commit */
  onto: string;
}

export interface GitRemoteComparison {
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  upstreamComparison?: GitRemoteComparison | null;
  files: GitStatusFile[];
  isClean: boolean;
  diffStats?: Record<string, { insertions: number; deletions: number }>;
  /** Present when a merge is in progress with conflicts */
  mergeInProgress?: GitMergeInProgress | null;
  /** Present when a rebase is in progress */
  rebaseInProgress?: GitRebaseInProgress | null;
  /** Phase 1: reason for attention-required state */
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GetGitDiffOptions {
  path: string;
  staged?: boolean;
  contextLines?: number;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

export interface GetGitFileDiffOptions {
  path: string;
  staged?: boolean;
}

export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitBranch {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
  defaultBranches?: Record<string, string>;
}

interface GitCommitSummary {
  changes: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitResult {
  success: boolean;
  commit: string;
  branch: string;
  summary: GitCommitSummary;
}

export interface GitPushResult {
  success: boolean;
  pushed: Array<{
    local: string;
    remote: string;
  }>;
  repo: string;
  ref: unknown;
}

export interface GitPullResult {
  success: boolean;
  summary: GitCommitSummary;
  files: string[];
  insertions: number;
  deletions: number;
}

export interface GitPullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export interface GitStashEntry {
  ref: string;
  message: string;
  relativeTime: string;
  hash: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitMergeResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface CheckoutCommitResponse {
  success: boolean;
}

export interface CherryPickResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface RevertCommitResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface ResetToCommitResponse {
  success: boolean;
}

export interface GitRebaseResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface MergeConflictDetails {
  /** Git status --porcelain output showing current state */
  statusPorcelain: string;
  /** List of unmerged file paths */
  unmergedFiles: string[];
  /** Git diff output showing current conflict state */
  diff: string;
  /** Information about MERGE_HEAD or REBASE_HEAD */
  headInfo: string;
  /** The operation type: 'merge' or 'rebase' */
  operation: 'merge' | 'rebase';
}

export type GitIdentityAuthType = 'ssh' | 'token';

export interface GitIdentityProfile {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: GitIdentityAuthType;
  sshKey?: string | null;
  signCommits?: boolean;
  signingKey?: string | null;
  host?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface DiscoveredGitCredential {
  host: string;
  username: string;
}

export interface GitIdentitySummary {
  userName: string | null;
  userEmail: string | null;
  sshCommand: string | null;
}

export interface GitCloneRepositoryInput {
  remoteUrl: string;
  destinationPath: string;
  gitIdentity?: GitIdentityProfile | null;
}

export interface GitCloneRepositoryResult {
  success: boolean;
  path: string;
  output?: string;
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  parents: string[];
}

export interface GitLogResponse {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
}

export interface CommitFileEntry {
  path: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  changeType: 'A' | 'M' | 'D' | 'R' | 'C' | string;
}

export interface GitCommitFilesResponse {
  files: CommitFileEntry[];
}

export interface CommitFileDiffResponse {
  original: string;
  modified: string;
  isBinary: boolean;
}

export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
}

export interface GitWorktreeValidationError {
  code: string;
  message: string;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: GitWorktreeValidationError[];
  resolved?: {
    mode?: 'new' | 'existing';
    localBranch?: string | null;
  };
}

export interface GitWorktreeBootstrapStatus {
  status: 'pending' | 'ready' | 'failed';
  phase?: 'directory-created' | 'git-ready' | 'setup-ready';
  error: string | null;
  updatedAt: number;
}

export interface CreateGitWorktreePayload {
  mode?: 'new' | 'existing';
  /** Worktree folder name (falls back to Varin name generation when omitted). */
  worktreeName?: string;
  /** New local branch name for mode=new. */
  branchName?: string;
  /** Existing local/remote branch for mode=existing. */
  existingBranch?: string;
  /** Start ref for mode=new (local/remote branch or commit SHA). */
  startRef?: string;
  /** Setup script to run after Git has populated the worktree. */
  startCommand?: string;
  /** Configure upstream tracking for the created/attached local branch. */
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  /** Optional remote provisioning (used for fork PR workflows). */
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  /** Return once the target directory exists and finish Git worktree setup in the background. */
  returnAfterDirectoryCreated?: boolean;
}

export interface GitWorktreeCreateResult {
  head: string;
  name: string;
  branch: string;
  path: string;
  directoryCreated?: true;
  bootstrapStatus?: GitWorktreeBootstrapStatus;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
}

export interface GitDeleteBranchPayload {
  branch: string;
  force?: boolean;
}

export interface GitDeleteRemoteBranchPayload {
  branch: string;
  remote?: string;
}

export interface GitRemoveRemotePayload {
  remote: string;
}

export interface CreateGitCommitOptions {
  addAll?: boolean;
  files?: string[];
  stageFiles?: string[];
}

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
  file?: string;
  all?: boolean;
}

export interface GeneratedCommitMessage {
  subject: string;
  highlights: string[];
}

export interface GeneratedPullRequestDescription {
  title: string;
  body: string;
}

interface GitWorktreeAPI {
  list(directory: string): Promise<GitWorktreeInfo[]>;
  validate?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  bootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  preview?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  create?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  remove?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
}

export interface GitAPI {
  cloneRepository(input: GitCloneRepositoryInput): Promise<GitCloneRepositoryResult>;
  checkIsGitRepository(directory: string): Promise<boolean>;
  getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<GitStatus>;
  getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse>;
  getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse>;
  revertGitFile(directory: string, filePath: string, options?: { scope?: 'all' | 'working' }): Promise<void>;
  stageGitFile(directory: string, filePath: string): Promise<void>;
  stageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  unstageGitFile(directory: string, filePath: string): Promise<void>;
  unstageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  stageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  unstageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  revertGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  isLinkedWorktree(directory: string): Promise<boolean>;
  getGitBranches(directory: string): Promise<GitBranch>;
  deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }>;
  deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }>;
  removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }>;
  generateCommitMessage(directory: string, files: string[], options?: { zenModel?: string; providerId?: string; modelId?: string }): Promise<{ message: GeneratedCommitMessage }>;
  generatePullRequestDescription(
    directory: string,
    payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
  ): Promise<GeneratedPullRequestDescription>;
  listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]>;
  validateGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  getGitWorktreeBootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  previewGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  createGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  deleteGitWorktree?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  createGitCommit(directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitPush(directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitPull(directory: string, options?: GitPullOptions): Promise<GitPullResult>;
  gitFetch(directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }>;
  countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }>;
  stashGitChanges(directory: string, options?: { message?: string }): Promise<{ success: boolean; created: boolean; message: string; output: string }>;
  applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }>;
  createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }>;
  renameBranch(directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }>;
  getGitLog(directory: string, options?: GitLogOptions): Promise<GitLogResponse>;
  getCommitFiles(directory: string, hash: string): Promise<GitCommitFilesResponse>;
  getCommitFileDiff?(directory: string, hash: string, filePath: string, isBinary: boolean): Promise<CommitFileDiffResponse>;
  getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null>;
  hasLocalIdentity?(directory: string): Promise<boolean>;
  setGitIdentity(directory: string, profileId: string): Promise<{ success: boolean; profile: GitIdentityProfile }>;
  getGitIdentities(): Promise<GitIdentityProfile[]>;
  createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile>;
  updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile>;
  deleteGitIdentity(id: string): Promise<void>;
  discoverGitCredentials?(): Promise<DiscoveredGitCredential[]>;
  getGlobalGitIdentity?(): Promise<GitIdentitySummary | null>;
  getRemoteUrl?(directory: string, remote?: string): Promise<string | null>;
  getRemotes(directory: string): Promise<GitRemote[]>;
  rebase(directory: string, options: { onto: string }): Promise<GitRebaseResult>;
  abortRebase(directory: string): Promise<{ success: boolean }>;
  continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  merge(directory: string, options: { branch: string }): Promise<GitMergeResult>;
  abortMerge(directory: string): Promise<{ success: boolean }>;
  continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  checkoutCommit(directory: string, hash: string): Promise<CheckoutCommitResponse>;
  cherryPick(directory: string, hash: string): Promise<CherryPickResponse>;
  revertCommit(directory: string, hash: string): Promise<RevertCommitResponse>;
  resetToCommit(directory: string, hash: string, mode: 'soft' | 'mixed' | 'hard', force?: boolean): Promise<ResetToCommitResponse>;
  stash(directory: string, options?: { message?: string; includeUntracked?: boolean }): Promise<{ success: boolean }>;
  stashPop(directory: string): Promise<{ success: boolean }>;
  getConflictDetails(directory: string): Promise<MergeConflictDetails>;
  /** Phase 1: validate that a cwd is inside a worktreeRoot */
  validateWorktreeDirectory?(directory: string, worktreeRoot: string): Promise<{
    valid: boolean;
    insideWorktreeRoot: boolean;
    resolvedWorktreeRoot: string | null;
    resolvedCwd: string | null;
  }>;
  /** Phase 1: canonicalize a directory to full worktree state */
  canonicalizeWorktreeState?(directory: string): Promise<{
    worktreeRoot: string | null;
    cwd: string | null;
    branch: string | null;
    headState: 'branch' | 'detached' | 'unborn';
    worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
    legacy: boolean;
    degraded: boolean;
    attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  }>;
  worktree?: GitWorktreeAPI;
}

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedTime?: number;
}

export interface DirectoryListResult {
  directory: string;
  entries: FileListEntry[];
}

export interface FileSearchQuery {
  directory: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
}

export interface FileSearchResult {
  path: string;
  score?: number;
  preview?: string[];
}

export interface CommandExecResult {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface ListDirectoryOptions {
  respectGitignore?: boolean;
}

export interface FileReadOptions {
  allowOutsideWorkspace?: boolean;
  outsideFileGrant?: string;
  optional?: boolean;
  directory?: string;
}

/** Browse, binary preview, and tree CRUD. Text content is DocumentsAPI. */
export interface FilesAPI {
  getHomeDirectory(): Promise<string>;
  listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryListResult>;
  search(payload: FileSearchQuery, options?: { signal?: AbortSignal }): Promise<FileSearchResult[]>;
  createDirectory(path: string, options?: { allowOutsideWorkspace?: boolean }): Promise<{ success: boolean; path: string }>;
  statFile?(path: string, options?: FileReadOptions): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }>;
  readFileBinary?(path: string, options?: FileReadOptions): Promise<{ dataUrl: string; path: string }>;
  delete?(path: string): Promise<{ success: boolean }>;
  rename?(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }>;
  revealPath?(path: string): Promise<{ success: boolean }>;
  execCommands?(commands: string[], cwd: string): Promise<{ success: boolean; results: CommandExecResult[] }>;
  downloadFile?(path: string): Promise<void>;
}

export interface ProjectEntry {
  id: string;
  /** Default execution folder. Project membership does not restrict file access. */
  path: string;
  /** Other folders explicitly included in this project and its background index. */
  additionalPaths?: string[];
  label?: string;
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultModel?: string;
  /** Captured by newly created conversations unless they provide an explicit work focus. */
  defaultWorkFocus?: WorkFocusId;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export interface SettingsPayload {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  projects?: ProjectEntry[];
  activeProjectId?: string | null;
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showReasoningTraces?: boolean;
  collapsibleThinkingBlocks?: boolean;
  showDeletionDialog?: boolean;
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  autoDeleteEnabled?: boolean;
  autoSaveEnabled?: boolean;
  autoDeleteAfterDays?: number;
  sessionRetentionAction?: 'archive' | 'delete';
  recoveryPreference?: 'conversation' | 'both' | 'ask';
  followUpBehavior?: 'steer' | 'queue';
  gitmojiEnabled?: boolean;
  inputSpellcheckEnabled?: boolean;
  showToolFileIcons?: boolean;
  codeBlockLineWrap?: boolean;
  showTurnChangedFiles?: boolean;
  showExpandedBashTools?: boolean;
  showExpandedEditTools?: boolean;
  chatContentWidth?: number;
  chatRenderMode?: 'sorted' | 'live';
  messageStreamTransport?: 'auto' | 'ws' | 'sse';
  activityRenderMode?: 'collapsed' | 'summary';
  mermaidRenderingMode?: 'svg' | 'ascii';
  fontSize?: number;
  terminalFontSize?: number;
  terminalShell?: TerminalShell;
  terminalLoginShells?: TerminalShell[];
  editorFontSize?: number;
  fileEditorSettings?: FileEditorSettingsPatch;
  uiFont?: string;
  monoFont?: string;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;
  shortcutOverrides?: Record<string, string>;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  gitChangesViewMode?: 'flat' | 'tree';
  directoryShowHidden?: boolean;
  filesViewShowGitignored?: boolean;
  openInAppId?: string;
  gitProviderId?: string;
  gitModelId?: string;
  pwaAppName?: string;
  mobileKeyboardMode?: 'native' | 'resize-content';
  draftStarters?: DraftStarterRef[];
  draftStartersVisible?: boolean;

  [key: string]: unknown;
}

export interface SettingsLoadResult {
  settings: SettingsPayload;
  source: 'desktop' | 'web';
}

export interface SettingsAPI {
  load(): Promise<SettingsLoadResult>;
  save(changes: Partial<SettingsPayload>): Promise<SettingsPayload>;
}

export interface DirectoryPermissionRequest {
  path: string;
}

interface DirectoryPermissionResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface StartAccessingResult {
  success: boolean;
  error?: string;
}

export interface PermissionsAPI {
  requestDirectoryAccess(request: DirectoryPermissionRequest): Promise<DirectoryPermissionResult>;
  startAccessingDirectory(path: string): Promise<StartAccessingResult>;
  stopAccessingDirectory(path: string): Promise<StartAccessingResult>;
}

export interface NotificationPayload {
  title?: string;
  body?: string;

  tag?: string;
  kind?: string;
  sessionId?: string;
  directory?: string;
  requireHidden?: boolean;
}

export interface NotificationsAPI {
  notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean>;
  canNotify?: () => boolean | Promise<boolean>;
}

export interface DiagnosticsAPI {
  downloadLogs(): Promise<{ fileName: string; content: string }>;
}

export interface ToolsAPI {

  getAvailableTools(): Promise<string[]>;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  origin?: string;
  /** Runtime surface for presence-aware routing. */
  platform?: string;
}

export interface PushUnsubscribePayload {
  endpoint: string;
}

export interface ApnsTokenPayload {
  token: string;
  /** 'ios' (APNs) or 'android' (FCM) — lets the relay route the token to the right service. */
  platform?: string;
  /**
   * APNs environment the token belongs to: 'sandbox' for Xcode/dev-signed installs,
   * 'production' for TestFlight/App Store. Omitted when unknown (server defaults to production).
   */
  environment?: 'sandbox' | 'production';
}

export interface PushAPI {
  getVapidPublicKey(): Promise<{ publicKey: string } | null>;
  subscribe(payload: PushSubscribePayload): Promise<{ ok: true } | null>;
  unsubscribe(payload: PushUnsubscribePayload): Promise<{ ok: true } | null>;
  setVisibility(payload: { visible: boolean; platform?: string }): Promise<{ ok: true } | null>;
  /** Register a native iOS APNs device token (Capacitor mobile app only). */
  registerApnsToken(payload: ApnsTokenPayload): Promise<{ ok: true } | null>;
  unregisterApnsToken(payload: ApnsTokenPayload): Promise<{ ok: true } | null>;
}

export interface WorkspaceGitSummary {
  isRepository: boolean;
  branch: string | null;
  isClean: boolean;
  dirty?: number;
  ahead?: number;
  behind?: number;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: string;
  mtimeMs: number;
  isProject?: boolean;
  git?: WorkspaceGitSummary | null;
  children?: WorkspaceEntry[];
}

export interface WorkspaceRootInfo {
  root: string;
  relativeRoot: string;
  exists: boolean;
  mtimeMs: number;
  limits: {
    maxReadBytes: number;
    maxUploadBytes: number;
    maxDownloadBytes?: number;
    maxDownloadFiles?: number;
    maxArchiveBytes?: number;
    maxExtractBytes?: number;
    maxExtractFiles?: number;
    archivePreviewLimit?: number;
  };
  features: {
    lockdown: boolean;
    trash: boolean;
    customCommands: boolean;
  };
  separator: string;
}

export interface WorkspaceListResult {
  path: string;
  relativePath: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceMutationResult {
  success: boolean;
  entry: WorkspaceEntry;
}

export interface WorkspaceDeleteResult {
  success: boolean;
  trashed: boolean;
  trashPath?: string;
}

export type WorkspaceUploadFile = File | {
  name: string;
  contentBase64: string;
};

export interface WorkspaceUploadResult {
  success: boolean;
  entries: WorkspaceEntry[];
}

export interface WorkspaceProjectOpenResult {
  success: boolean;
  project: ProjectEntry;
  settings: SettingsPayload;
}

export type WorkspaceGitStatus = GitStatus & {
  isGitRepository?: boolean;
};

export interface WorkspaceGitCloneOptions {
  url: string;
  branch?: string;
  directoryName?: string;
}

export interface WorkspaceGitCloneResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  directoryName?: string | null;
}

export interface WorkspaceArchivePreviewEntry {
  path: string;
  type: 'file' | 'directory';
  size: number;
}

export interface WorkspaceArchivePreview {
  archive: WorkspaceEntry;
  format: 'zip' | 'tar' | 'tgz';
  entries: WorkspaceArchivePreviewEntry[];
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
  truncated: boolean;
}

export interface WorkspaceArchiveExtractRequest {
  path: string;
  destination: string;
  mode: 'new-folder' | 'merge';
  conflict: 'rename' | 'skip' | 'error';
  deleteArchive?: boolean;
}

export interface WorkspaceArchiveExtractResult {
  success: true;
  destination: string;
  destinationEntry: WorkspaceEntry;
  filesCreated: number;
  directoriesCreated: number;
  bytesExtracted?: number;
  archiveDeleted?: boolean;
  bytesWritten?: number;
  conflictsRenamed?: number;
  conflictsSkipped?: number;
  deletedArchive?: boolean;
}

export interface WorkspaceAPI {
  getRoot(): Promise<WorkspaceRootInfo>;
  list(path?: string): Promise<WorkspaceListResult>;
  tree(path?: string, depth?: number): Promise<WorkspaceListResult>;
  entry(path: string): Promise<WorkspaceEntry>;
  createFolder(path: string): Promise<WorkspaceMutationResult>;
  createFile(path: string, content?: string): Promise<WorkspaceMutationResult>;
  move(from: string, to: string): Promise<WorkspaceMutationResult>;
  deleteEntry(path: string, options?: { permanent?: boolean }): Promise<WorkspaceDeleteResult>;
  upload(path: string, files: WorkspaceUploadFile[]): Promise<WorkspaceUploadResult>;
  download(path: string): Promise<void>;
  previewArchive(path: string): Promise<WorkspaceArchivePreview>;
  extractArchive(request: WorkspaceArchiveExtractRequest): Promise<WorkspaceArchiveExtractResult>;
  openProject(path: string): Promise<WorkspaceProjectOpenResult>;
  gitStatus(path: string, options?: { mode?: 'light' }): Promise<WorkspaceGitStatus>;
  gitFetch(path: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  gitClone(path: string, options: WorkspaceGitCloneOptions): Promise<WorkspaceGitCloneResult>;
  gitPull(path: string, options?: { remote?: string; branch?: string }): Promise<GitPullResult>;
  gitPush(path: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitCheckout(path: string, branch: string): Promise<{ success: boolean; branch: string }>;
  gitCommit(path: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitLog(path: string, options?: GitLogOptions): Promise<GitLogResponse>;
  gitRemotes(path: string): Promise<GitRemote[]>;
}

export interface MobileDevice {
  id: string;
  name: string;
  platform: 'ios' | 'android' | 'unknown';
  appVersion?: string | null;
  pushProvider?: string | null;
  pushEnabled: boolean;
  enabled: boolean;
  createdAt: number;
  lastSeenAt?: number | null;
  lastPushSuccessAt?: number | null;
  lastPushFailureAt?: number | null;
}

export interface MobilePairStartResult {
  pairingToken: string;
  expiresAt: number;
  serverUrl: string | null;
  qrPayload: {
    serverUrl: string | null;
    pairingToken: string;
  };
}

export interface MobileTestPushResult {
  ok: boolean;
  sent?: number;
  failed?: number;
  reason?: string;
}

export interface MobileAPI {
  startPairing(payload?: { serverUrl?: string }): Promise<MobilePairStartResult | null>;
  listDevices(): Promise<{ devices: MobileDevice[] } | null>;
  deleteDevice(deviceId: string): Promise<{ ok: true; deleted: boolean } | null>;
  sendTestPush(deviceId: string): Promise<MobileTestPushResult | null>;
}

export type GitHubUserSummary = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

type GitHubRepoRef = {
  owner: string;
  repo: string;
  url: string;
};

export type GitHubChecksSummary = {
  state: 'success' | 'failure' | 'pending' | 'unknown';
  total: number;
  success: number;
  failure: number;
  /** queued + in_progress + unconcluded runs. */
  pending: number;
  inProgress?: number;
  queued?: number;
  /** Earliest started_at among in-progress runs (ISO), for elapsed display. */
  startedAt?: string;
};

export type GitHubCheckRun = {
  id?: number;
  name: string;
  startedAt?: string;
  completedAt?: string;
  app?: {
    name?: string;
    slug?: string;
  };
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
  job?: {
    runId?: number;
    jobId?: number;
    url?: string;
    name?: string;
    workflowName?: string;
    conclusion?: string | null;
    steps?: Array<{
      name: string;
      status?: string;
      conclusion?: string | null;
      number?: number;
      startedAt?: string;
      completedAt?: string;
    }>;
  };
  annotations?: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    level?: string;
    message: string;
    title?: string;
    rawDetails?: string;
  }>;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  base: string;
  head: string;
  headSha?: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};

type GitHubPullRequestHeadRepo = {
  owner: string;
  repo: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
};

export type GitHubPullRequestSummary = GitHubPullRequest & {
  author?: GitHubUserSummary | null;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  headLabel?: string;
  headRepo?: GitHubPullRequestHeadRepo | null;
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

type GitHubPullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

type GitHubPullRequestReviewComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  path?: string;
  line?: number | null;
  position?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubPullRequestsListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  prs?: GitHubPullRequestSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubPullRequestContextResult = {
  connected: boolean;
  /** Server-side stamp of when the data was fetched from GitHub (ms epoch); survives server cache serves. */
  fetchedAt?: number;
  repo?: GitHubRepoRef | null;
  pr?: GitHubPullRequestSummary | null;
  issueComments?: GitHubIssueComment[];
  reviewComments?: GitHubPullRequestReviewComment[];
  files?: GitHubPullRequestFile[];
  diff?: string;
  checks?: GitHubChecksSummary | null;
  checkRuns?: GitHubCheckRun[];
};

export type GitHubPullRequestStatus = {
  connected: boolean;
  /** Server-side stamp of when the data was fetched from GitHub (ms epoch); survives server cache serves. */
  fetchedAt?: number;
  repo?: GitHubRepoRef | null;
  branch?: string;
  pr?: GitHubPullRequest | null;
  checks?: GitHubChecksSummary | null;
  canMerge?: boolean;
  defaultBranch?: string | null;
  resolvedRemoteName?: string | null;
};

export type GitHubPullRequestCreateInput = {
  directory: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  /** Remote to create the PR against (target repo, e.g., 'upstream' for forks) */
  remote?: string;
  /** Remote where the head branch lives (source repo, e.g., 'origin' for forks) */
  headRemote?: string;
  /** Explicit target repo (alternative to remote, for auto-detected upstream) */
  targetRepo?: { owner: string; repo: string };
};

export type GitHubPullRequestUpdateInput = {
  directory: string;
  number: number;
  title: string;
  body?: string;
};

export type GitHubPullRequestMergeInput = {
  directory: string;
  number: number;
  method: 'merge' | 'squash' | 'rebase';
};

export type GitHubPullRequestReadyInput = {
  directory: string;
  number: number;
};

export type GitHubPullRequestReadyResult = {
  ready: boolean;
};

export type GitHubPullRequestMergeResult = {
  merged: boolean;
  message?: string;
};

type GitHubIssueLabel = {
  name: string;
  color?: string;
};

export type GitHubRepoSelector = {
  owner: string;
  repo: string;
};

export type GitHubIssueSummary = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author?: GitHubUserSummary | null;
  labels?: GitHubIssueLabel[];
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

export type GitHubIssue = GitHubIssueSummary & {
  body?: string;
  assignees?: GitHubUserSummary[];
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssueComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssuesListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issues?: GitHubIssueSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubRepoUpstreamResult = {
  connected: boolean;
  isFork: boolean;
  upstream: { owner: string; repo: string; url: string; defaultBranch: string; defaultBranchSha: string | null; remoteName: string | null } | null;
};

export type GitHubIssueGetResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issue?: GitHubIssue | null;
};

export type GitHubIssueCommentsResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  comments?: GitHubIssueComment[];
};

export type GitHubAuthStatus = {
  connected: boolean;
  user?: GitHubUserSummary | null;
  scope?: string;
  accounts?: GitHubAuthAccount[];
  ghCli?: {
    available: boolean;
    disabled: boolean;
    active: boolean;
    user?: GitHubUserSummary | null;
  } | null;
};

type GitHubAuthAccount = {
  id: string;
  user: GitHubUserSummary;
  scope?: string;
  current?: boolean;
  source?: 'oauth' | 'gh-cli';
};

export type GitHubDeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
};

export type GitHubDeviceFlowComplete =
  | { connected: true; user: GitHubUserSummary; scope?: string }
  | { connected: false; status?: string; error?: string };

export type GitHubTerminalAuthResult = {
  success: boolean;
  ghConfigPath: string;
  helperPath: string;
  gitCredentialHelperConfigured: boolean;
  gitCredentialHelperError?: string;
};

export type GitHubGitAuthorResult = {
  success: boolean;
  userName: string;
  userEmail: string;
};

export interface GitHubAPI {
  authStatus(): Promise<GitHubAuthStatus>;
  authStart(): Promise<GitHubDeviceFlowStart>;
  authComplete(deviceCode: string): Promise<GitHubDeviceFlowComplete>;
  authDisconnect(): Promise<{ removed: boolean }>;
  authActivate(accountId: string): Promise<GitHubAuthStatus>;
  authSetGhCliDisabled(disabled: boolean): Promise<{ disabled: boolean }>;
  authSyncTerminal(options?: { configureGit?: boolean }): Promise<GitHubTerminalAuthResult>;
  authConfigureGitAuthor(): Promise<GitHubGitAuthorResult>;
  me?(): Promise<GitHubUserSummary>;

  prStatus(directory: string, branch: string, remote?: string, options?: { force?: boolean }): Promise<GitHubPullRequestStatus>;
  prCreate(payload: GitHubPullRequestCreateInput): Promise<GitHubPullRequest>;
  prUpdate(payload: GitHubPullRequestUpdateInput): Promise<GitHubPullRequest>;
  prMerge(payload: GitHubPullRequestMergeInput): Promise<GitHubPullRequestMergeResult>;
  prReady(payload: GitHubPullRequestReadyInput): Promise<GitHubPullRequestReadyResult>;

  prsList(directory: string, options?: { page?: number; query?: string }): Promise<GitHubPullRequestsListResult>;
  prContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; includeCheckDetails?: boolean; sourceRepo?: GitHubRepoSelector | null }
  ): Promise<GitHubPullRequestContextResult>;

  issuesList(directory: string, options?: { page?: number; query?: string }): Promise<GitHubIssuesListResult>;
  issueGet(directory: string, number: number, options?: { sourceRepo?: GitHubRepoSelector | null }): Promise<GitHubIssueGetResult>;
  issueComments(directory: string, number: number, options?: { sourceRepo?: GitHubRepoSelector | null }): Promise<GitHubIssueCommentsResult>;
  repoUpstream(directory: string): Promise<GitHubRepoUpstreamResult>;
  repoBranches(owner: string, repo: string): Promise<string[]>;
}

export interface RemoteClientRecord {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt?: string | null;
  clientKind?: string | null;
  profile?: string | null;
  capabilities?: string[];
  allowedDirectories?: string[];
  authMethod?: string | null;
  /** Pairing session this client was created from, when authMethod is 'pairing'. */
  pairingId?: string | null;
  deviceName?: string | null;
  devicePlatform?: string | null;
  deviceModel?: string | null;
  appVersion?: string | null;
  usesRelay?: boolean;
  /** Transport that carried the device's most recent authenticated request. */
  lastTransport?: 'relay' | 'direct' | null;
}

// A pairing link that has been created but not yet redeemed by a device.
export interface PendingPairingRecord {
  id: string;
  label?: string;
  fingerprint?: string | null;
  expiresAt?: string;
  usesRelay?: boolean;
}

export interface RemoteClientCreateResult {
  client: RemoteClientRecord;
  token: string;
}

export interface RemoteClientRevokeResult {
  revoked: boolean;
  client?: RemoteClientRecord;
}

export interface RemoteClientPurgeRevokedResult {
  purged: number;
}

export interface PairingSessionCreateResult {
  pairing: {
    id: string;
    label?: string;
    fingerprint?: string | null;
    expiresAt?: string;
    secret: string;
  };
  server: {
    label: string;
    // Transport candidates for the pairing-v2 payload. Shape matches
    // PairingEndpointCandidate in `@/lib/connectionPayload` (direct lan/tunnel or
    // relay); left as a structural type here so this contract file stays leaf.
    candidates: Array<Record<string, unknown>>;
  };
}

export interface ClientAuthAPI {
  listClients(): Promise<RemoteClientRecord[]>;
  createClient(input?: {
    label?: string;
    expiresAt?: string | null;
    clientKind?: string | null;
    dedupeKey?: string | null;
    profile?: string | null;
    capabilities?: string[];
    allowedDirectories?: string[];
  }): Promise<RemoteClientCreateResult>;
  // Creates a one-time pairing session (pairing v2). `serverUrl` is the
  // externally reachable URL to advertise as the direct candidate (the desktop
  // UI talks to its server over loopback, so it must supply the LAN URL); the
  // server folds in a relay candidate when its relay host is enabled.
  createPairingSession(input?: {
    label?: string;
    allowedClientKinds?: Array<'mobile' | 'desktop'>;
    serverUrl?: string;
    // Per-link transport choice. `includeRelay: true` adds the relay candidate
    // and enables the relay host on demand; `false` omits it; omitted keeps the
    // legacy "relay only if already enabled" behavior. `includeDirect: false`
    // produces a relay-only link (no direct candidate).
    includeRelay?: boolean;
    includeDirect?: boolean;
  }): Promise<PairingSessionCreateResult>;
  purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult>;
  revokeClient(id: string): Promise<RemoteClientRevokeResult>;
  // Pairing links created but not yet redeemed (the "pending devices" list).
  listPendingPairings(): Promise<PendingPairingRecord[]>;
  cancelPairing(id: string): Promise<{ cancelled: boolean }>;
  // Direct transports the server can be reached on, for the create-device dialog.
  // LAN reflects the server's actual bind, independent of the UI origin.
  getPairingTransports(): Promise<{ local: string | null; lan: string | null; relayAvailable: boolean }>;
}

export type SmartSearchConfigValueSource = 'default' | 'environment' | 'config_file';

export interface SmartSearchConfigValue {
  key: string;
  isSet: boolean;
  value?: string;
  maskedValue?: string;
  secret: boolean;
  source: SmartSearchConfigValueSource;
  editable: boolean;
}

export interface SmartSearchPathInfo {
  ok?: boolean;
  binary?: string;
  config_file?: string;
  config_dir?: string;
  config_dir_source?: string;
  error?: string;
}

export interface SmartSearchConfigResponse {
  ok: boolean;
  path?: SmartSearchPathInfo;
  values: Record<string, SmartSearchConfigValue>;
}

export interface SmartSearchConfigPatch {
  set?: Record<string, string>;
  unset?: string[];
}

export interface SmartSearchStatusResponse {
  ok: boolean;
  available: boolean;
  binary: string;
  version?: string;
  path?: SmartSearchPathInfo;
  error?: string;
}

export interface SmartSearchDoctorResponse {
  ok: boolean;
  exitCode?: number | null;
  signal?: string | null;
  result?: unknown;
  stderr?: string;
}

export interface SmartSearchAPI {
  status(): Promise<SmartSearchStatusResponse>;
  loadConfig(): Promise<SmartSearchConfigResponse>;
  saveConfig(patch: SmartSearchConfigPatch): Promise<SmartSearchConfigResponse>;
  doctor(): Promise<SmartSearchDoctorResponse>;
}

export interface ExtensionsAPI {
  activateExtension(extensionId: string): Promise<void>;
  catalog(): Promise<VarinExtensionCatalogAvailability>;
  discardPreparedCandidate(extensionId: string, candidateIntegrity: string): Promise<void>;
  discardCandidate(request: VarinExtensionCandidateSelectionRequest): Promise<VarinExtensionCatalogSnapshot>;
  hostState(): Promise<VarinExtensionHostStateSnapshot>;
  install(request: VarinExtensionPackageInstallRequest): Promise<VarinExtensionCatalogSnapshot>;
  invokeService(request: VarinExtensionServiceInvocationRequest): Promise<JsonValue>;
  prepareCandidate(extensionId: string, candidateIntegrity: string): Promise<VarinExtensionCandidatePreparationResult>;
  requestCandidateApplication(request: VarinExtensionCandidateSelectionRequest): Promise<VarinExtensionCatalogSnapshot>;
  readAsset(request: VarinExtensionAssetRequest): Promise<VarinExtensionAssetPayload>;
  readManagedEntrypoint(request: VarinExtensionManagedEntrypointRequest): Promise<VarinExtensionManagedEntrypointPayload>;
  reloadLocalSource(request: VarinExtensionLocalSourceReloadRequest): Promise<VarinExtensionLocalSourceReloadResult>;
  reportActualState(extensionId: string, state: VarinExtensionActualState): Promise<void>;
  reviewCapabilities(request: VarinExtensionCapabilityReviewRequest): Promise<VarinExtensionCatalogSnapshot>;
  reviewCandidateCapabilities(request: VarinExtensionCandidateCapabilityReviewRequest): Promise<VarinExtensionCatalogSnapshot>;
  selectCandidate(request: VarinExtensionCandidateSelectionRequest): Promise<VarinExtensionCatalogSnapshot>;
  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<VarinExtensionCatalogSnapshot>;
  setServiceSelection(request: VarinExtensionServiceSelectionRequest): Promise<VarinExtensionHostStateSnapshot>;
  upsertServiceRoutingRule(request: VarinExtensionServiceRoutingRuleUpdateRequest): Promise<VarinExtensionServiceRoutingSnapshot>;
  removeServiceRoutingRule(request: VarinExtensionServiceRoutingRuleRemoveRequest): Promise<VarinExtensionServiceRoutingSnapshot>;
  removeExtension(request: VarinExtensionRemoveRequest): Promise<VarinExtensionCatalogSnapshot>;
  updateWorkbenchLayout(request: VarinWorkbenchLayoutUpdateRequest): Promise<VarinWorkbenchProfileSnapshot>;
  selectWorkbenchProfile(request: VarinWorkbenchProfileSelectionRequest): Promise<VarinWorkbenchProfileSnapshot>;
  upsertWorkbenchProfile(request: VarinWorkbenchProfileUpsertRequest): Promise<VarinWorkbenchProfileSnapshot>;
  removeWorkbenchProfile(request: VarinWorkbenchProfileRemoveRequest): Promise<VarinWorkbenchProfileSnapshot>;
  applyWorkbenchProfile(request: VarinWorkbenchProfileApplyRequest): Promise<VarinExtensionCatalogSnapshot>;
  waitForHostState(request: VarinExtensionHostStateWaitRequest, signal?: AbortSignal): Promise<VarinExtensionHostStateSnapshot>;
}

export interface PiRuntimeManagementCapabilities {
  install: boolean;
  openLocation: boolean;
  pickPackageRoot: boolean;
}

export interface PiRuntimeManagementAPI {
  activate(id: string): Promise<PiRuntimeSnapshot>;
  activateCustom(packageRoot: string, nodePath?: string): Promise<PiRuntimeSnapshot>;
  capabilities: PiRuntimeManagementCapabilities;
  getSnapshot(): Promise<PiRuntimeSnapshot>;
  install(): Promise<PiRuntimeSnapshot>;
  openLocation(targetPath: string): Promise<void>;
  pickPackageRoot(): Promise<string | null>;
  refresh(): Promise<PiRuntimeSnapshot>;
  subscribe(listener: (snapshot: PiRuntimeSnapshot) => void): () => void;
  upgrade(): Promise<PiRuntimeSnapshot>;
}

export interface VarinWorkspaceIdentity {
  workspaceId: string;
  hostId: string;
  epoch: number;
}

export interface VarinResourceReference {
  workspaceId: string;
  resourceId: string;
}

export interface WorkspaceMutationOwner {
  kind: string;
  id: string;
  generation?: number;
}

export interface WorkspaceMutationToken {
  workspaceId: string;
  epoch: number;
  owner: WorkspaceMutationOwner;
}

export type VarinDocumentReadResult =
  | {
      status: 'ready';
      epoch: number;
      resource: VarinResourceReference;
      revision: string;
      content: string;
      encoding: string;
      bom: boolean;
      byteLength: number;
      modifiedAt?: string;
    }
  | {
      status: 'missing';
      epoch: number;
      resource: VarinResourceReference;
    }
  | {
      status: 'binary';
      epoch: number;
      resource: VarinResourceReference;
      revision: string;
      byteLength: number;
      mime?: string;
    }
  | {
      status: 'unsupported-encoding';
      epoch: number;
      resource: VarinResourceReference;
      revision: string;
      byteLength: number;
      candidates?: string[];
    };

export interface VarinDocumentWriteRequest {
  token: WorkspaceMutationToken;
  resource: VarinResourceReference;
  content: string;
  encoding: string;
  bom: boolean;
  expectedRevision: string | null;
  operationId: string;
}

export type VarinDocumentWriteResult =
  | { status: 'written'; revision: string; byteLength: number; modifiedAt?: string }
  | { status: 'conflict'; current: Omit<VarinDocumentReadResult, 'content'> }
  | { status: 'stale-epoch'; currentEpoch: number };

export interface VarinDocumentMoveRequest {
  token: WorkspaceMutationToken;
  from: VarinResourceReference;
  to: VarinResourceReference;
  expectedRevision: string;
  operationId: string;
}

export type VarinDocumentMoveResult =
  | { status: 'moved'; resource: VarinResourceReference; revision: string; byteLength: number; modifiedAt?: string }
  | { status: 'missing'; resource: VarinResourceReference }
  | { status: 'target-exists'; resource: VarinResourceReference }
  | { status: 'conflict'; current: Omit<VarinDocumentReadResult, 'content'> }
  | { status: 'stale-epoch'; currentEpoch: number };

export interface VarinDocumentDeleteRequest {
  token: WorkspaceMutationToken;
  resource: VarinResourceReference;
  expectedRevision: string;
  operationId: string;
}

export type VarinDocumentDeleteResult =
  | { status: 'deleted'; resource: VarinResourceReference }
  | { status: 'missing'; resource: VarinResourceReference }
  | { status: 'conflict'; current: Omit<VarinDocumentReadResult, 'content'> }
  | { status: 'stale-epoch'; currentEpoch: number };

type VarinWorkspaceFileEventPosition = {
  sourceId: string;
  generation: number;
  sequence: number;
};

export type VarinWorkspaceFileEvent = VarinWorkspaceFileEventPosition & (
  | { kind: 'created' | 'changed' | 'deleted'; resource: VarinResourceReference; revision?: string }
  | { kind: 'moved'; from: VarinResourceReference; resource: VarinResourceReference; revision?: string }
  | { kind: 'reset'; reason: 'overflow' | 'reconnected' | 'authority-changed' | 'gap' }
);

export type VarinDirtyStateBarrierEvent = {
  action: 'acquire' | 'release';
  barrierId: string;
  caseSensitive: boolean;
  kind: 'dirty-state-barrier';
  paths: string[];
  workspaceId: string;
};

export type VarinDocumentSurfaceOperationEvent = {
  action: 'capture' | 'apply' | 'undo';
  kind: 'surface-operation';
  operationId: string;
  requestId: string;
  workspaceId: string;
};

export type VarinDocumentWatchEvent =
  | VarinWorkspaceFileEvent
  | VarinDirtyStateBarrierEvent
  | VarinDocumentSurfaceOperationEvent;

export interface VarinDocumentRecoveryJournalSummary {
  journalId: string;
  resource: VarinResourceReference;
  revision: number;
  baseRevision: string | null;
  epoch: number;
  updatedAt: string;
  byteLength: number;
}

export interface VarinDirtyBufferResource {
  baseRevision: string | null;
  /** Hash of the editor-normalized buffer text, not the serialized file bytes. */
  bufferHash?: string;
  documentInstanceId?: string;
  encoding?: string;
  bom?: boolean;
  lineEnding?: 'lf' | 'crlf' | 'cr';
  localEditRevision: number;
  resource: VarinResourceReference;
}

export interface VarinDocumentSurfaceBinding {
  baseRevision: string | null;
  bufferHash: string;
  documentInstanceId: string;
  encoding: string;
  bom: boolean;
  lineEnding: 'lf' | 'crlf' | 'cr';
  localEditRevision: number;
  resource: VarinResourceReference;
}

export interface VarinDocumentSurfaceOperationTarget extends VarinDocumentSurfaceBinding {
  newText?: string;
  expectedAppliedRevision?: number;
  expectedAppliedHash?: string;
}

export interface VarinDocumentSurfaceOperationPayload {
  action: 'capture' | 'apply' | 'undo';
  operationId: string;
  requestId: string;
  targets: VarinDocumentSurfaceOperationTarget[];
  workspaceId: string;
}

export interface VarinDocumentSurfaceOperationResourceResult {
  resource: VarinResourceReference;
  status: 'captured' | 'applied' | 'undone' | 'failed';
  documentInstanceId?: string;
  beforeLocalEditRevision?: number;
  beforeHash?: string;
  afterLocalEditRevision?: number;
  afterHash?: string;
  content?: string;
  message?: string;
}

export interface VarinDocumentSurfaceOperationCompletion {
  generation: number;
  ownerId: string;
  operationId: string;
  requestId: string;
  resources: VarinDocumentSurfaceOperationResourceResult[];
  workspaceId: string;
}

export interface VarinAgentInputSnapshotResource extends VarinDirtyBufferResource {
  content: string;
  encoding: string;
  bom: boolean;
}

export interface VarinAgentInputSnapshotCaptureRequest {
  generation: number;
  ownerId: string;
  resources: VarinAgentInputSnapshotResource[];
  sessionId: string;
}

export interface VarinDirtyBufferPublication {
  generation: number;
  ownerId: string;
  resources: VarinDirtyBufferResource[];
  updatedAt: string;
  workspaceId: string;
}

export type VarinDocumentRecoveryReadResult =
  | {
      status: 'ready';
      journal: VarinDocumentRecoveryJournalSummary;
      content: string;
      encoding: string;
      bom: boolean;
    }
  | { status: 'missing'; journalId: string }
  | { status: 'malformed'; journalId: string };

export interface VarinDocumentRecoveryWriteRequest {
  token: WorkspaceMutationToken;
  workspaceId: string;
  recoverySessionId: string;
  resource: VarinResourceReference;
  content: string;
  encoding: string;
  bom: boolean;
  baseRevision: string | null;
  expectedRevision: number | null;
}

export type VarinDocumentRecoveryWriteResult =
  | { status: 'written'; journal: VarinDocumentRecoveryJournalSummary }
  | { status: 'conflict'; journal: VarinDocumentRecoveryJournalSummary }
  | { status: 'missing'; journalId: string }
  | { status: 'stale-epoch'; currentEpoch: number };

export interface DocumentsAPI {
  ackDirtyStateBarrier?(request: {
    barrierId: string;
    generation: number;
    ownerId: string;
    workspaceId: string;
  }): Promise<{ acknowledged: boolean }>;
  clearDirtyBuffers(request: {
    generation: number;
    ownerId: string;
    workspaceId: string;
  }): Promise<{ cleared: boolean }>;
  captureAgentInputSnapshot?(request: VarinAgentInputSnapshotCaptureRequest): Promise<AgentInputContext>;
  releaseAgentInputSnapshot?(request: { context: AgentInputContext; sessionId: string }): Promise<{ released: boolean }>;
  readSurfaceOperation?(request: {
    generation: number;
    ownerId: string;
    requestId: string;
    workspaceId: string;
  }): Promise<VarinDocumentSurfaceOperationPayload>;
  completeSurfaceOperation?(request: VarinDocumentSurfaceOperationCompletion): Promise<{ accepted: boolean }>;
  resolveWorkspace(input: { path?: string; workspaceId?: string }): Promise<VarinWorkspaceIdentity>;
  /** Opaque Host and canonical-target identity for coordinating aliases of one file. Never use it as an open path. */
  resolveResourceIdentity(resource: VarinResourceReference): Promise<{
    coordinationId: string;
    /** Registered references to this same target, including the requested reference. */
    aliases: VarinResourceReference[];
  }>;
  read(resource: VarinResourceReference): Promise<VarinDocumentReadResult>;
  write(request: VarinDocumentWriteRequest): Promise<VarinDocumentWriteResult>;
  move(request: VarinDocumentMoveRequest): Promise<VarinDocumentMoveResult>;
  delete(request: VarinDocumentDeleteRequest): Promise<VarinDocumentDeleteResult>;
  watch(
    workspaceId: string,
    listener: (event: VarinDocumentWatchEvent) => void,
    options?: {
      dirtyOwner?: { generation: number; ownerId: string };
      signal?: AbortSignal;
    },
  ): Subscription;
  listRecoveryJournals(request: {
    workspaceId: string;
    recoverySessionId?: string;
  }): Promise<VarinDocumentRecoveryJournalSummary[]>;
  publishDirtyBuffers(request: {
    generation: number;
    ownerId: string;
    resources: VarinDirtyBufferResource[];
    workspaceId: string;
  }): Promise<VarinDirtyBufferPublication>;
  readRecoveryJournal(journalId: string): Promise<VarinDocumentRecoveryReadResult>;
  writeRecoveryJournal(request: VarinDocumentRecoveryWriteRequest): Promise<VarinDocumentRecoveryWriteResult>;
  deleteRecoveryJournal(request: {
    token: WorkspaceMutationToken;
    journalId: string;
    expectedRevision: number;
  }): Promise<
    | { status: 'deleted' }
    | { status: 'missing' }
    | { status: 'conflict'; journal: VarinDocumentRecoveryJournalSummary }
    | { status: 'stale-epoch'; currentEpoch: number }
  >;
}

export type WorkspaceContentSearchHit = {
  resource: VarinResourceReference;
  line: number;
  column: number;
  preview: string;
};

export type WorkspaceContentSearchResult =
  | { status: 'ready'; generation: number; hits: WorkspaceContentSearchHit[] }
  | { status: 'empty'; generation: number }
  | { status: 'cancelled'; generation: number }
  | { status: 'failure'; generation: number; message: string };

export interface WorkspaceContentSearchRequest {
  workspaceId: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
}

export interface WorkspaceSearchAPI {
  searchContent(
    request: WorkspaceContentSearchRequest,
    options?: {
      signal?: AbortSignal;
      onBatch?: (hits: WorkspaceContentSearchHit[]) => void;
    },
  ): Promise<WorkspaceContentSearchResult>;
}

export type VarinLanguageProviderFeatures = {
  completionTriggerCharacters?: string[];
  signatureHelpTriggerCharacters?: string[];
  signatureHelpRetriggerCharacters?: string[];
  onTypeFormattingTriggerCharacters?: string[];
};

export type VarinLanguageProviderStatus =
  | { status: 'absent'; workspaceId: string; languageId: string; providerId?: string; generation?: number }
  | { status: 'starting'; workspaceId: string; languageId: string; providerId: string; generation: number }
  | { status: 'ready'; workspaceId: string; languageId: string; providerId: string; generation: number; features?: VarinLanguageProviderFeatures }
  | { status: 'degraded'; workspaceId: string; languageId: string; providerId: string; generation: number; message: string; features?: VarinLanguageProviderFeatures }
  | { status: 'failed'; workspaceId: string; languageId: string; providerId: string; generation: number; message: string };

export type VarinLanguagePosition = {
  line: number;
  character: number;
};

export type VarinLanguageRange = {
  start: VarinLanguagePosition;
  end: VarinLanguagePosition;
};

export type VarinLanguageCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  insertTextFormat?: 'plain' | 'snippet';
  documentation?: VarinLanguageMarkupContent;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  deprecated?: boolean;
  commitCharacters?: string[];
  tags?: number[];
  textEdit?: VarinLanguageTextEdit | VarinLanguageInsertReplaceEdit;
  additionalTextEdits?: VarinLanguageTextEdit[];
  command?: VarinLanguageCommand;
  resolveToken?: string;
};

export type VarinLanguageLocation = {
  resource: VarinResourceReference;
  range: VarinLanguageRange;
};

export type VarinLanguageLocationLink = {
  resource: VarinResourceReference;
  targetRange: VarinLanguageRange;
  targetSelectionRange: VarinLanguageRange;
  originSelectionRange?: VarinLanguageRange;
};

export type VarinLanguageMarkupContent = {
  kind: 'plaintext' | 'markdown';
  value: string;
};

export type VarinLanguageCommand = {
  title: string;
  command: string;
  arguments?: JsonValue[];
};

export type VarinLanguageTextEdit = {
  range: VarinLanguageRange;
  newText: string;
  annotationId?: string;
};

export type VarinLanguageInsertReplaceEdit = {
  insert: VarinLanguageRange;
  replace: VarinLanguageRange;
  newText: string;
};

export type VarinLanguageHover = {
  contents: VarinLanguageMarkupContent[];
  range?: VarinLanguageRange;
};

export type VarinLanguageSignatureParameter = {
  label: string | [number, number];
  documentation?: VarinLanguageMarkupContent;
};

export type VarinLanguageSignatureInformation = {
  label: string;
  documentation?: VarinLanguageMarkupContent;
  parameters: VarinLanguageSignatureParameter[];
  activeParameter?: number;
};

export type VarinLanguageSignatureHelp = {
  signatures: VarinLanguageSignatureInformation[];
  activeSignature: number;
  activeParameter: number;
};

export type VarinLanguageSymbol = {
  name: string;
  kind: number;
  range: VarinLanguageRange;
  selectionRange?: VarinLanguageRange;
  detail?: string;
  containerName?: string;
  tags?: number[];
  resource?: VarinResourceReference;
  children?: VarinLanguageSymbol[];
};

export type VarinLanguageWorkspaceDocumentEdit = {
  kind: 'text';
  resource: VarinResourceReference;
  version: number | null;
  edits: VarinLanguageTextEdit[];
};

export type VarinLanguageWorkspaceResourceOperation =
  | { kind: 'create'; resource: VarinResourceReference; annotationId?: string; overwrite?: boolean; ignoreIfExists?: boolean }
  | { kind: 'rename'; from: VarinResourceReference; to: VarinResourceReference; annotationId?: string; overwrite?: boolean; ignoreIfExists?: boolean }
  | { kind: 'delete'; resource: VarinResourceReference; annotationId?: string; recursive?: boolean; ignoreIfNotExists?: boolean };

export type VarinLanguageWorkspaceEdit = {
  documentChanges: Array<VarinLanguageWorkspaceDocumentEdit | VarinLanguageWorkspaceResourceOperation>;
  changeAnnotations?: Record<string, { label: string; description?: string; needsConfirmation?: boolean }>;
};

export type VarinLanguageCodeAction = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: VarinLanguageDiagnostic[];
  disabledReason?: string;
  edit?: VarinLanguageWorkspaceEdit;
  command?: VarinLanguageCommand;
  resolveToken?: string;
};

export type VarinLanguageSemanticTokens = {
  data: number[];
  resultId?: string;
  legend: {
    tokenTypes: string[];
    tokenModifiers: string[];
  };
};

export type VarinLanguageInlayHintLabelPart = {
  value: string;
  tooltip?: VarinLanguageMarkupContent;
  location?: VarinLanguageLocation;
  command?: VarinLanguageCommand;
};

export type VarinLanguageInlayHint = {
  position: VarinLanguagePosition;
  label: string | VarinLanguageInlayHintLabelPart[];
  kind?: 'type' | 'parameter';
  tooltip?: VarinLanguageMarkupContent;
  textEdits?: VarinLanguageTextEdit[];
  paddingLeft?: boolean;
  paddingRight?: boolean;
  resolveToken?: string;
};

export type VarinLanguageDocumentHighlight = {
  range: VarinLanguageRange;
  kind?: 'text' | 'read' | 'write';
};

export type VarinLanguageFoldingRange = {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  kind?: 'comment' | 'imports' | 'region';
};

export type VarinLanguageSelectionRange = {
  range: VarinLanguageRange;
  parent?: VarinLanguageSelectionRange;
};

export type VarinLanguageDocumentLinkTarget =
  | { kind: 'resource'; resource: VarinResourceReference; range?: VarinLanguageRange }
  | { kind: 'uri'; uri: string };

export type VarinLanguageDocumentLink = {
  range: VarinLanguageRange;
  target?: VarinLanguageDocumentLinkTarget;
  tooltip?: string;
  resolveToken?: string;
};

export type VarinLanguageColor = { red: number; green: number; blue: number; alpha: number };

export type VarinLanguageColorInformation = {
  range: VarinLanguageRange;
  color: VarinLanguageColor;
};

export type VarinLanguageColorPresentation = {
  label: string;
  textEdit?: VarinLanguageTextEdit;
  additionalTextEdits?: VarinLanguageTextEdit[];
};

export type VarinLanguageFeatureResult<T> =
  | { status: 'ready'; documentVersion: number; providerId: string; generation: number; value: T }
  | { status: 'stale'; documentVersion: number; providerId?: string; generation?: number }
  | { status: 'absent'; workspaceId?: string; languageId?: string }
  | {
      status: 'failed';
      message: string;
      reason?: 'provider-failed' | 'request-failed' | 'unsupported' | 'untrusted';
      providerId?: string;
      generation?: number;
    };

export interface VarinLanguageCommandRequest {
  resource: VarinResourceReference;
  languageId: string;
  documentVersion: number;
  providerId: string;
  generation: number;
  command: string;
  arguments?: JsonValue[];
}

export interface VarinLanguageDocumentSyncRequest {
  resource: VarinResourceReference;
  languageId: string;
  documentVersion: number;
  reason: 'open' | 'change' | 'save' | 'close';
  content?: string;
  changes?: Array<{ from: number; to: number; insert: string }>;
}

export type VarinLanguageDocumentSyncResult =
  | { status: 'synced'; documentVersion: number; providerId: string; generation: number }
  | { status: 'absent' }
  | { status: 'stale'; documentVersion: number }
  | { status: 'failed'; message: string };

export type VarinLanguageDiagnostic = {
  resource: VarinResourceReference;
  documentVersion: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: VarinLanguageRange;
  code?: string | number;
  source?: string;
  tags?: number[];
  relatedInformation?: Array<{ location: VarinLanguageLocation; message: string }>;
  providerId?: string;
  generation?: number;
};

export type VarinLanguageServiceEvent =
  | { kind: 'status'; snapshot: VarinLanguageProviderStatus }
  | {
      kind: 'diagnostics';
      workspaceId: string;
      languageId: string;
      resourceId: string;
      providerId: string;
      generation: number;
      items: VarinLanguageDiagnostic[];
    };

export interface VarinLanguageFeatureRequest {
  resource: VarinResourceReference;
  languageId: string;
  documentVersion: number;
  position?: VarinLanguagePosition;
  range?: VarinLanguageRange;
  newName?: string;
  query?: string;
  triggerCharacter?: string;
  triggerKind?: 'invoked' | 'triggerCharacter' | 'incomplete';
  resolveToken?: string;
  positions?: VarinLanguagePosition[];
  previousResultId?: string;
  color?: VarinLanguageColor;
  diagnostics?: VarinLanguageDiagnostic[];
  formatting?: {
    tabSize: number;
    insertSpaces: boolean;
    trimTrailingWhitespace?: boolean;
    insertFinalNewline?: boolean;
    trimFinalNewlines?: boolean;
  };
}

export interface LanguageServicesAPI {
  getStatus(workspaceId: string, languageId: string): Promise<VarinLanguageProviderStatus>;
  subscribe(
    workspaceId: string,
    listener: (event: VarinLanguageServiceEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  syncDocument(request: VarinLanguageDocumentSyncRequest): Promise<VarinLanguageDocumentSyncResult>;
  completion(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageCompletionItem[]>>;
  completionResolve(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageCompletionItem>>;
  hover(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageHover | null>>;
  signatureHelp(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageSignatureHelp | null>>;
  definition(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageLocationLink[]>>;
  references(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageLocation[]>>;
  documentSymbols(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageSymbol[]>>;
  workspaceSymbols(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageSymbol[]>>;
  rename(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageWorkspaceEdit | null>>;
  codeActions(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageCodeAction[]>>;
  codeActionResolve(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageCodeAction>>;
  executeCommand(request: VarinLanguageCommandRequest): Promise<VarinLanguageFeatureResult<JsonValue | null>>;
  documentFormatting(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageTextEdit[]>>;
  documentRangeFormatting(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageTextEdit[]>>;
  onTypeFormatting(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageTextEdit[]>>;
  semanticTokens(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageSemanticTokens | null>>;
  inlayHints(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageInlayHint[]>>;
  inlayHintResolve(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageInlayHint>>;
  documentHighlights(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageDocumentHighlight[]>>;
  foldingRanges(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageFoldingRange[]>>;
  selectionRanges(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageSelectionRange[]>>;
  documentLinks(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageDocumentLink[]>>;
  documentLinkResolve(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageDocumentLink>>;
  documentColors(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageColorInformation[]>>;
  colorPresentations(request: VarinLanguageFeatureRequest): Promise<VarinLanguageFeatureResult<VarinLanguageColorPresentation[]>>;
  restart(workspaceId: string, languageId: string): Promise<VarinLanguageProviderStatus>;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export type StructureGrammarStatus =
  | 'bundled'
  | 'installed'
  | 'available'
  | 'absent'
  | 'user-unverified'
  /** The installed-grammar index could not be read, so this is not "absent". */
  | 'unknown';

export interface LanguageSupportCapabilities {
  outline: boolean;
  classifyHits: boolean;
  literalCalls: boolean;
  imports: boolean;
}

export interface LanguageSupportPackInfo {
  abi: number;
  bytes: number;
  packageName: string;
  version: string;
  /**
   * The pack ships a query that was compiled against its grammar at publish
   * time. When false, installing it adds a parser and no outline, so callers
   * must say that before the user installs rather than after.
   */
  providesOutline: boolean;
}

export interface LanguageSupportLanguageRow {
  languageId: string;
  grammarStatus: StructureGrammarStatus;
  capabilities: LanguageSupportCapabilities;
  fileCount: number;
  wanted: boolean;
  pack?: LanguageSupportPackInfo;
  server?: LanguageSupportServerInfo;
}

/** Availability of the program, independent of a currently running LSP session. */
export interface LanguageSupportServerInfo {
  status: 'bundled' | 'available' | 'preparing' | 'installed' | 'failed' | 'needs-runtime' | 'unsupported';
  name?: string;
  message?: string;
}

/**
 * `unreadable` means the installed-grammar index could not be read, so the
 * grammar columns are unknown rather than empty. Callers must not render an
 * unreadable store as "nothing installed".
 */
export type LanguageSupportStoreStatus = 'ready' | 'unreadable';

export interface LanguageSupportStatus {
  workspaceId: string;
  languages: LanguageSupportLanguageRow[];
  partial: boolean;
  scannedFiles: number;
  fileLimit: number;
  grammarStore: LanguageSupportStoreStatus;
}

export type LanguageSupportFailureReason =
  | 'failed'
  | 'unsupported'
  | 'cancelled'
  | 'integrity'
  | 'abi'
  | 'store-unreadable'
  | 'absent';

export type LanguageSupportInstallResult =
  | { status: 'ready'; languageId: string; grammarStatus: StructureGrammarStatus }
  | { status: 'failed'; languageId: string; message: string; reason: LanguageSupportFailureReason }
  | { status: 'cancelled'; languageId: string };

export interface LanguageSupportAPI {
  getStatus(request: { workspaceId: string }): Promise<LanguageSupportStatus>;
  prepareServer(request: { workspaceId: string; languageId: string }): Promise<LanguageSupportServerInfo>;
  cancelServerPreparation(request: { workspaceId: string; languageId: string }): Promise<void>;
  install(request: { languageId: string }): Promise<LanguageSupportInstallResult>;
  cancelInstall(request: { languageId: string }): Promise<LanguageSupportInstallResult>;
  importUserGrammar(request: { languageId: string; path: string }): Promise<LanguageSupportInstallResult>;
}

export type VarinTaskConfigurationType = 'node' | 'process' | 'npm';

export type VarinTaskConfiguration = {
  id: string;
  label: string;
  type: VarinTaskConfigurationType;
  script?: string;
  command?: string;
  args?: string[];
};

export type VarinTaskListResult =
  | { status: 'ready'; workspaceId: string; configurations: VarinTaskConfiguration[] }
  | { status: 'failure'; workspaceId: string; message: string; configurations: [] };

export type VarinTaskRunStatus =
  | { status: 'running' | 'stopped' | 'failed'; workspaceId: string; runId?: string; taskId?: string; generation?: number; message?: string; exitCode?: number };

export type VarinTaskEvent =
  | { kind: 'status'; snapshot: VarinTaskRunStatus }
  | { kind: 'output'; runId: string; channel: string; text: string };

export interface WorkspaceTasksAPI {
  list(workspaceId: string): Promise<VarinTaskListResult>;
  run(request: { workspaceId: string; taskId: string }): Promise<VarinTaskRunStatus>;
  cancel(request: { workspaceId: string; runId: string }): Promise<VarinTaskRunStatus>;
  subscribe(
    workspaceId: string,
    listener: (event: VarinTaskEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export type VarinDebugSessionStatus =
  | { status: 'absent'; workspaceId: string; message?: string }
  | {
      status: 'starting' | 'running' | 'paused' | 'stopped' | 'failed';
      workspaceId: string;
      sessionId?: string;
      generation?: number;
      adapterId?: string;
      message?: string;
      reason?: string;
    };

export type VarinBreakpoint = {
  resourceId: string;
  line: number;
};

export type VarinDebugBreakpointMutationRequest = {
  workspaceId: string;
  resourceId: string;
  lines: number[];
} & (
  | { expectedSessionId: string; expectedGeneration: number }
  | { expectedSessionId: null; expectedGeneration: null }
);

export type VarinDebugBreakpointsResult = {
  status: 'ready' | 'stale';
  workspaceId: string;
  sessionId?: string;
  generation?: number;
  breakpoints: VarinBreakpoint[];
};

export type VarinDebugBreakpointListResult = VarinDebugBreakpointsResult & {
  status: 'ready';
};

export type VarinDebugThread = {
  id: number;
  name: string;
};

export type VarinDebugStackFrame = {
  id: number;
  name: string;
  line: number;
  column: number;
  resourceId?: string;
};

export type VarinDebugScope = {
  name: string;
  variablesReference: number;
};

export type VarinDebugVariable = {
  name: string;
  value: string;
  variablesReference: number;
  type?: string;
};

export type VarinDebugFeatureResult<T> =
  | { status: 'ready'; workspaceId: string; sessionId?: string; generation?: number; value: T }
  | { status: 'absent'; workspaceId?: string }
  | { status: 'failed'; workspaceId?: string; sessionId?: string; generation?: number; message: string };

export type VarinDebugEvent =
  | { kind: 'status'; snapshot: VarinDebugSessionStatus }
  | { kind: 'breakpoints'; snapshot: VarinDebugBreakpointListResult }
  | { kind: 'output'; sessionId: string; channel: string; text: string };

export interface WorkspaceDebugAPI {
  getStatus(workspaceId: string): Promise<VarinDebugSessionStatus>;
  listBreakpoints(workspaceId: string): Promise<VarinDebugBreakpointListResult>;
  setBreakpoints(request: VarinDebugBreakpointMutationRequest): Promise<VarinDebugBreakpointsResult>;
  start(request: { workspaceId: string; program?: string; languageId?: string; adapterId?: string }): Promise<VarinDebugSessionStatus>;
  stop(request: { workspaceId: string }): Promise<VarinDebugSessionStatus>;
  continue(request: { workspaceId: string }): Promise<VarinDebugSessionStatus>;
  pause(request: { workspaceId: string }): Promise<VarinDebugSessionStatus>;
  stepOver(request: { workspaceId: string }): Promise<VarinDebugSessionStatus>;
  stepIn(request: { workspaceId: string }): Promise<VarinDebugSessionStatus>;
  stepOut(request: { workspaceId: string }): Promise<VarinDebugSessionStatus>;
  getThreads(request: { workspaceId: string }): Promise<VarinDebugFeatureResult<VarinDebugThread[]>>;
  getStack(request: { workspaceId: string; threadId: number }): Promise<VarinDebugFeatureResult<VarinDebugStackFrame[]>>;
  getScopes(request: { workspaceId: string; frameId: number }): Promise<VarinDebugFeatureResult<VarinDebugScope[]>>;
  getVariables(request: { workspaceId: string; variablesReference: number }): Promise<VarinDebugFeatureResult<VarinDebugVariable[]>>;
  evaluate(request: { workspaceId: string; expression: string; frameId?: number }): Promise<VarinDebugFeatureResult<string>>;
  listWatch(workspaceId: string): Promise<{ status: 'ready'; workspaceId: string; expressions: string[] }>;
  addWatch(request: { workspaceId: string; expression: string }): Promise<{ status: 'ready' | 'failed'; workspaceId: string; expressions?: string[]; message?: string }>;
  removeWatch(request: { workspaceId: string; expression: string }): Promise<{ status: 'ready'; workspaceId: string; expressions: string[] }>;
  subscribe(
    workspaceId: string,
    listener: (event: VarinDebugEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export type VarinTestItem = {
  id: string;
  label: string;
  resourceId?: string;
  line?: number;
  status?: 'running' | 'passed' | 'failed';
  message?: string;
  stack?: string;
};

export type VarinTestDiscoverResult =
  | { status: 'ready' | 'empty' | 'absent' | 'cancelled'; workspaceId: string; tests: VarinTestItem[] }
  | { status: 'failure'; workspaceId: string; message: string; tests: [] };

export type VarinTestRunStatus =
  | { status: 'absent' | 'idle' | 'empty' | 'running' | 'stopped' | 'failed'; workspaceId: string; runId?: string; generation?: number; providerId?: string; message?: string };

export type VarinTestEvent =
  | { kind: 'status'; snapshot: VarinTestRunStatus }
  | { kind: 'test'; runId: string; generation: number; test: VarinTestItem }
  | { kind: 'output'; channel: string; runId: string; generation: number; text: string }
  | { kind: 'finished'; runId: string; generation: number; results?: VarinTestItem[] };

export interface WorkspaceTestAPI {
  discover(request: { workspaceId: string; providerId?: string }): Promise<VarinTestDiscoverResult>;
  run(request: { workspaceId: string; testIds?: string[]; providerId?: string }): Promise<VarinTestRunStatus>;
  cancel(request: { workspaceId: string }): Promise<VarinTestRunStatus>;
  getStatus(workspaceId: string): Promise<VarinTestRunStatus>;
  subscribe(
    workspaceId: string,
    listener: (event: VarinTestEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export interface RuntimeAPIs {
  runtime: RuntimeDescriptor;
  piRuntime?: PiRuntimeManagementAPI;
  terminal: TerminalAPI;
  git: GitAPI;
  workspace?: WorkspaceAPI;
  files: FilesAPI;
  documents: DocumentsAPI;
  workspaceSearch: WorkspaceSearchAPI;
  language: LanguageServicesAPI;
  languageSupport: LanguageSupportAPI;
  tasks: WorkspaceTasksAPI;
  debug: WorkspaceDebugAPI;
  tests: WorkspaceTestAPI;
  settings: SettingsAPI;
  permissions: PermissionsAPI;
  notifications: NotificationsAPI;
  github?: GitHubAPI;
  push?: PushAPI;
  mobile?: MobileAPI;
  diagnostics?: DiagnosticsAPI;
  clientAuth?: ClientAuthAPI;
  smartSearch?: SmartSearchAPI;
  extensions: ExtensionsAPI;
  tools: ToolsAPI;
  worktrees?: WorktreeMetadata[];
}

export type RuntimeAPISelector<TValue> = (apis: RuntimeAPIs) => TValue;

// ============== Skills Catalog Types ==============

type SkillsCatalogSourceId = string;

type SkillsCatalogSourceType = 'github' | 'clawdhub';

export interface SkillsCatalogSource {
  id: SkillsCatalogSourceId;
  label: string;
  description?: string;
  source: string;
  defaultSubpath?: string;
  sourceType?: SkillsCatalogSourceType;
}

interface SkillsCatalogItemInstalledBadge {
  isInstalled: boolean;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents' | 'claude';
}

interface ClawdHubSkillMetadata {
  slug: string;
  version: string;
  displayName?: string;
  owner?: string;
  downloads?: number;
  stars?: number;
  versionsCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SkillsCatalogItem {
  sourceId: SkillsCatalogSourceId;
  repoSource: string;
  repoSubpath?: string;
  gitIdentityId?: string;
  skillDir: string;
  skillName: string;
  frontmatterName?: string;
  description?: string;
  installable: boolean;
  warnings?: string[];
  installed?: SkillsCatalogItemInstalledBadge;
  /** ClawdHub-specific metadata (present only for ClawdHub sources) */
  clawdhub?: ClawdHubSkillMetadata;
}

export interface SkillsCatalogResponse {
  ok: boolean;
  sources?: SkillsCatalogSource[];
  itemsBySource?: Record<SkillsCatalogSourceId, SkillsCatalogItem[]>;
  pageInfoBySource?: Record<SkillsCatalogSourceId, { nextCursor?: string | null }>;
  error?: { kind: string; message: string };
}

export interface SkillsCatalogSourceResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  nextCursor?: string | null;
  error?: { kind: string; message: string };
}

export interface SkillsRepoScanRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

type SkillsRepoScanError =
  | { kind: 'authRequired'; message: string; sshOnly: true; identities?: Array<{ id: string; name: string }> }
  | { kind: 'invalidSource'; message: string }
  | { kind: 'gitUnavailable'; message: string }
  | { kind: 'networkError'; message: string }
  | { kind: 'unknown'; message: string };

export interface SkillsRepoScanResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  error?: SkillsRepoScanError;
}

interface SkillsInstallSelection {
  skillDir: string;
  /** ClawdHub-specific metadata for installation */
  clawdhub?: {
    slug: string;
    version: string;
  };
}

export interface SkillsInstallRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
  scope: 'user' | 'project';
  targetSource?: 'opencode' | 'agents';
  selections: SkillsInstallSelection[];
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}

export type SkillsInstallError = SkillsRepoScanError | {
  kind: 'conflicts';
  message: string;
  conflicts: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
};

export interface SkillsInstallResponse {
  ok: boolean;
  installed?: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
  skipped?: Array<{ skillName: string; reason: string }>;
  error?: SkillsInstallError;
  requiresReload?: boolean;
  message?: string;
  reloadDelayMs?: number;
}
