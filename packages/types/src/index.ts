export type WorkspaceMode = "live" | "shadow";

export type MountAccessMode = "ro" | "rw";

export type ProcessEnvMode = "none" | "allow-matching" | "all";

export type EnvClassification = "public" | "secret";

export type WorkerdSourceLanguage = "js" | "ts" | "tsx";

export interface FileEnvSource {
  type: "file";
  path: string;
  optional?: boolean;
}

export interface ProcessEnvSource {
  type: "process";
}

export interface InlineEnvSource {
  type: "inline";
  values: Record<string, string>;
}

export type EnvSource = FileEnvSource | ProcessEnvSource | InlineEnvSource;

export interface EnvPolicy {
  sources?: readonly EnvSource[];
  include?: readonly string[];
  exclude?: readonly string[];
  publicPatterns?: readonly string[];
  secretPatterns?: readonly string[];
  processEnv?: ProcessEnvMode;
}

export interface ResolvedEnvEntry {
  value: string;
  classification: EnvClassification;
  source: string;
}

export interface ResolvedEnvSnapshot {
  entries: Readonly<Record<string, ResolvedEnvEntry>>;
  publicKeys: readonly string[];
  secretKeys: readonly string[];
}

export interface ResolvedEnv {
  snapshot(): ResolvedEnvSnapshot;
  get(name: string): string | undefined;
  getClassification(name: string): EnvClassification | undefined;
  toObject(options?: { includeSecrets?: boolean }): Record<string, string>;
}

export interface WorkspaceMount {
  mountPath: string;
  sourcePath: string;
  mode: MountAccessMode;
}

export interface WorkspaceOptions {
  root: string;
  mode?: WorkspaceMode;
  mounts?: readonly WorkspaceMount[];
  denyRead?: readonly string[];
}

export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "other";

export interface WorkspaceEntry {
  path: string;
  kind: WorkspaceEntryKind;
  size: number;
}

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  column: number;
  content: string;
}

export interface WorkspaceController {
  readonly root: string;
  readonly mode: WorkspaceMode;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  list(path?: string): Promise<readonly WorkspaceEntry[]>;
  stat(path: string): Promise<WorkspaceEntry>;
  glob(pattern: string | readonly string[]): Promise<readonly string[]>;
  grep(
    query: string,
    options?: {
      include?: string | readonly string[];
      caseSensitive?: boolean;
      maxResults?: number;
    },
  ): Promise<readonly WorkspaceSearchResult[]>;
  remove(path: string): Promise<void>;
  resolvePath(path: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface ExecPolicy {
  allowedCommands?: readonly string[];
  allowShell?: boolean;
  defaultTimeoutMs?: number;
}

export interface ExecRunOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envKeys?: readonly string[];
  includeSecrets?: boolean;
}

export interface ExecShellOptions {
  script: string;
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envKeys?: readonly string[];
  includeSecrets?: boolean;
}

export interface ExecRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecController {
  run(options: ExecRunOptions): Promise<ExecRunResult>;
  shell(options: ExecShellOptions): Promise<ExecRunResult>;
}

export interface NetworkPolicy {
  allowFetch?: boolean;
  allowedFetchOrigins?: readonly string[];
}

export interface WorkerdSessionOptions {
  allowFetch?: boolean;
  allowedFetchOrigins?: readonly string[];
  startupTimeoutMs?: number;
  compatibilityDate?: string;
  compatibilityFlags?: readonly string[];
  workerdBinary?: string;
}

export type WorkerdRunInput = string | { path: string };

export interface WorkerdRunOptions {
  language?: WorkerdSourceLanguage;
  name?: string;
  exportName?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: unknown;
}

export interface WorkerdRunResult {
  result: unknown;
  logs: readonly string[];
  durationMs: number;
}

export interface WorkerdRunErrorDetails {
  name?: string;
  message: string;
  stack?: string;
}

export interface WorkerdSession {
  readonly port: number;
  readonly status: "created" | "started" | "stopped";
  start(): Promise<void>;
  run(input: WorkerdRunInput, options?: WorkerdRunOptions): Promise<WorkerdRunResult>;
  stop(): Promise<void>;
}

export type ObservabilityScope = "container" | "workspace" | "exec" | "env" | "net";

export type ObservabilityOutcome = "success" | "error" | "denied";

export interface ObservabilityEvent {
  timestamp: string;
  scope: ObservabilityScope;
  action: string;
  outcome: ObservabilityOutcome;
  target?: string;
  detail?: string;
}

export interface ObservabilitySink {
  emit(event: ObservabilityEvent): void | Promise<void>;
}

export interface AgentContainerOptions {
  workspace: WorkspaceOptions;
  env?: EnvPolicy;
  exec?: ExecPolicy;
  network?: NetworkPolicy;
  observability?: ObservabilitySink;
}

export type ContainerStatus = "created" | "started" | "stopped";

export interface AgentContainerDescription {
  root: string;
  workspaceMode: WorkspaceMode;
  bindings: readonly string[];
  hasEnvPolicy: boolean;
  hasExecPolicy: boolean;
  hasNetworkPolicy: boolean;
  envPublicKeys: readonly string[];
  envSecretKeys: readonly string[];
}

export interface AgentContainer {
  readonly options: AgentContainerOptions;
  readonly status: ContainerStatus;
  readonly workspace: WorkspaceController;
  readonly env: ResolvedEnv;
  readonly exec: ExecController;
  start(): Promise<void>;
  stop(): Promise<void>;
  describe(): AgentContainerDescription;
  createWorkerdSession(options?: WorkerdSessionOptions): Promise<WorkerdSession>;
}

export interface HarnessToolBindingMap {
  read?: string;
  write?: string;
  edit?: string;
  glob?: string;
  grep?: string;
  bash?: string;
}

export interface AgentContainerPluginOptions {
  name: string;
  container: AgentContainerOptions;
  tools?: HarnessToolBindingMap;
}

export interface AgentContainerPluginDefinition {
  name: string;
  container: AgentContainerOptions;
  capabilities: readonly string[];
  tools: HarnessToolBindingMap;
}
