import type {
  AgentContainer,
  AgentContainerOptions,
  AgentContainerPluginDefinition,
  AgentContainerPluginOptions,
  ExecController,
  ResolvedEnv,
  WorkerdSession,
  WorkerdSessionOptions,
  WorkspaceController,
} from "@agent-container/types";

export { LocalCapabilityBridgeServer } from "./bridge.js";
export { LocalExecController } from "./exec.js";
export { createWorkerdSession, LocalWorkerdSession } from "./workerd/index.js";
export { LocalWorkspaceController } from "./workspace.js";

export type {
  AgentContainer,
  AgentContainerDescription,
  AgentContainerOptions,
  AgentContainerPluginDefinition,
  AgentContainerPluginOptions,
  ContainerStatus,
  EnvPolicy,
  ExecController,
  ExecPolicy,
  ExecRunOptions,
  ExecRunResult,
  ExecShellOptions,
  HarnessToolBindingMap,
  NetworkPolicy,
  ObservabilityEvent,
  ObservabilitySink,
  ResolvedEnv,
  ResolvedEnvEntry,
  ResolvedEnvSnapshot,
  WorkerdRunOptions,
  WorkerdRunResult,
  WorkerdSession,
  WorkerdSessionOptions,
  WorkspaceController,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceMode,
  WorkspaceMount,
  WorkspaceSearchResult,
  WorkspaceOptions,
} from "@agent-container/types";

const notImplemented = (name: string): Error => {
  return new Error(`${name} is not implemented yet in this incremental branch.`);
};

function createWorkspaceStub(): WorkspaceController {
  return {
    root: "",
    mode: "shadow",
    async read(_path: string): Promise<Uint8Array> {
      throw notImplemented("LocalWorkspaceController.read");
    },
    async readText(_path: string): Promise<string> {
      throw notImplemented("LocalWorkspaceController.readText");
    },
    async write(_path: string, _content: string | Uint8Array): Promise<void> {
      throw notImplemented("LocalWorkspaceController.write");
    },
    async list(_path?: string): Promise<readonly []> {
      throw notImplemented("LocalWorkspaceController.list");
    },
    async stat(_path: string): Promise<never> {
      throw notImplemented("LocalWorkspaceController.stat");
    },
    async glob(_pattern: string | readonly string[]): Promise<readonly string[]> {
      throw notImplemented("LocalWorkspaceController.glob");
    },
    async grep(
      _query: string,
      _options?: {
        include?: string | readonly string[];
        caseSensitive?: boolean;
        maxResults?: number;
      },
    ): Promise<readonly []> {
      throw notImplemented("LocalWorkspaceController.grep");
    },
    async remove(_path: string): Promise<void> {
      throw notImplemented("LocalWorkspaceController.remove");
    },
    async resolvePath(_path: string): Promise<string> {
      throw notImplemented("LocalWorkspaceController.resolvePath");
    },
    async dispose(): Promise<void> {
      throw notImplemented("LocalWorkspaceController.dispose");
    },
  };
}

function createExecStub(): ExecController {
  return {
    async run(): Promise<never> {
      throw notImplemented("LocalExecController.run");
    },
    async shell(): Promise<never> {
      throw notImplemented("LocalExecController.shell");
    },
  };
}

export class LocalAgentContainer implements AgentContainer {
  public readonly status = "created" as const;
  public readonly workspace: WorkspaceController;
  public readonly env: ResolvedEnv;
  public readonly exec: ExecController;

  public constructor(public readonly options: AgentContainerOptions) {
    this.workspace = createWorkspaceStub();
    this.env = {
      snapshot() {
        throw notImplemented("ResolvedEnv.snapshot");
      },
      get() {
        throw notImplemented("ResolvedEnv.get");
      },
      getClassification() {
        throw notImplemented("ResolvedEnv.getClassification");
      },
      toObject() {
        throw notImplemented("ResolvedEnv.toObject");
      },
    };
    this.exec = createExecStub();
  }

  public async start(): Promise<void> {
    throw notImplemented("LocalAgentContainer.start");
  }

  public async stop(): Promise<void> {
    throw notImplemented("LocalAgentContainer.stop");
  }

  public describe(): never {
    throw notImplemented("LocalAgentContainer.describe");
  }

  public async createWorkerdSession(_options?: WorkerdSessionOptions): Promise<WorkerdSession> {
    throw notImplemented("LocalAgentContainer.createWorkerdSession");
  }
}

export async function createAgentContainer(
  options: AgentContainerOptions,
): Promise<AgentContainer> {
  return new LocalAgentContainer(options);
}

export function defineAgentContainerPlugin(
  options: AgentContainerPluginOptions,
): AgentContainerPluginDefinition {
  return {
    name: options.name,
    container: options.container,
    capabilities: [],
    tools: options.tools ?? {},
  };
}

export function resolveEnv(): never {
  throw notImplemented("resolveEnv");
}
