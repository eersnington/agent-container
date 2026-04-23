import type {
  AgentContainer,
  AgentContainerDescription,
  AgentContainerOptions,
  AgentContainerPluginDefinition,
  AgentContainerPluginOptions,
  ContainerStatus,
  ExecController,
  ObservabilityEvent,
  ResolvedEnv,
  WorkerdSession,
  WorkerdSessionOptions,
  WorkspaceController,
} from "@agent-container/types";

import { resolveEnv } from "./env.js";
import { LocalExecController } from "./exec.js";
import { createManagedWorkerdSession } from "./workerd/index.js";
import { LocalWorkspaceController } from "./workspace.js";

const DEFAULT_BINDINGS = ["WORKSPACE", "EXEC", "ENV", "SECRETS", "OBSERVE"] as const;

const DEFAULT_TOOL_BINDINGS = {
  read: "WORKSPACE.read",
  write: "WORKSPACE.write",
  glob: "WORKSPACE.glob",
  grep: "WORKSPACE.grep",
  bash: "EXEC.run",
} as const;

function nowIsoString(): string {
  return new Date().toISOString();
}

async function emitWithSink(
  options: AgentContainerOptions,
  event: Omit<ObservabilityEvent, "timestamp">,
): Promise<void> {
  const sink = options.observability;
  if (sink === undefined) {
    return;
  }

  await sink.emit({
    timestamp: nowIsoString(),
    ...event,
  });
}

export class LocalAgentContainer implements AgentContainer {
  public readonly options: AgentContainerOptions;

  public readonly workspace: WorkspaceController;

  public readonly env: ResolvedEnv;

  public readonly exec: ExecController;

  #status: ContainerStatus = "created";

  readonly #sessions = new Set<WorkerdSession>();

  public constructor(
    options: AgentContainerOptions,
    workspace: WorkspaceController,
    env: ResolvedEnv,
    exec: ExecController,
  ) {
    this.options = options;
    this.workspace = workspace;
    this.env = env;
    this.exec = exec;
  }

  public get status(): ContainerStatus {
    return this.#status;
  }

  public async start(): Promise<void> {
    if (this.#status === "started") {
      return;
    }

    this.#status = "started";
    await this.#emit({
      scope: "container",
      action: "start",
      outcome: "success",
      target: this.options.workspace.root,
    });
  }

  public async stop(): Promise<void> {
    if (this.#status === "stopped") {
      return;
    }

    for (const session of this.#sessions) {
      await session.stop();
    }
    this.#sessions.clear();
    await this.workspace.dispose();

    this.#status = "stopped";
    await this.#emit({
      scope: "container",
      action: "stop",
      outcome: "success",
      target: this.options.workspace.root,
    });
  }

  public describe(): AgentContainerDescription {
    const envSnapshot = this.env.snapshot();
    return {
      root: this.workspace.root,
      workspaceMode: this.workspace.mode,
      bindings: DEFAULT_BINDINGS,
      hasEnvPolicy: this.options.env !== undefined,
      hasExecPolicy: this.options.exec !== undefined,
      hasNetworkPolicy: this.options.network !== undefined,
      envPublicKeys: envSnapshot.publicKeys,
      envSecretKeys: envSnapshot.secretKeys,
    };
  }

  public async createWorkerdSession(options: WorkerdSessionOptions = {}): Promise<WorkerdSession> {
    const session = await createManagedWorkerdSession(
      {
        allowFetch: options.allowFetch ?? this.options.network?.allowFetch ?? false,
        allowedFetchOrigins:
          options.allowedFetchOrigins ?? this.options.network?.allowedFetchOrigins ?? [],
        startupTimeoutMs: options.startupTimeoutMs,
        compatibilityDate: options.compatibilityDate,
        workerdBinary: options.workerdBinary,
      },
      {
        workspace: this.workspace,
        env: this.env,
        exec: this.exec,
      },
      this.#emit.bind(this),
    );
    this.#sessions.add(session);
    return session;
  }

  async #emit(event: Omit<ObservabilityEvent, "timestamp">): Promise<void> {
    await emitWithSink(this.options, event);
  }
}

export async function createAgentContainer(
  options: AgentContainerOptions,
): Promise<AgentContainer> {
  const workspace = await LocalWorkspaceController.create(
    options.workspace,
    (event) => emitWithSink(options, event),
    { env: options.env },
  );
  const env = await resolveEnv(workspace.root, options.env);
  const exec = new LocalExecController({
    workspace,
    env,
    policy: options.exec,
    emit: (event) => emitWithSink(options, event),
  });
  const envSnapshot = env.snapshot();
  await emitWithSink(options, {
    scope: "env",
    action: "resolve",
    outcome: "success",
    detail: `${envSnapshot.publicKeys.length} public, ${envSnapshot.secretKeys.length} secret`,
  });
  return new LocalAgentContainer(options, workspace, env, exec);
}

export function defineAgentContainerPlugin(
  options: AgentContainerPluginOptions,
): AgentContainerPluginDefinition {
  return {
    name: options.name,
    container: options.container,
    capabilities: DEFAULT_BINDINGS,
    tools: {
      ...DEFAULT_TOOL_BINDINGS,
      ...options.tools,
    },
  };
}
