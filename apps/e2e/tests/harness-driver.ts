import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAgentContainer } from "agent-container";
import {
  createTempWorkspace,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "@agent-container/test-utils";
import type {
  AgentContainer,
  ObservabilityEvent,
  WorkerdRunResult,
  WorkerdSession,
  WorkspaceMode,
} from "@agent-container/types";

export interface SeedWorkspace extends TempWorkspace {
  root: string;
}

export interface HarnessDriver {
  readonly container: AgentContainer;
  readonly session: WorkerdSession;
  readonly events: readonly ObservabilityEvent[];
  run(code: string, env?: Record<string, string>): Promise<WorkerdRunResult>;
  readSeedFile(path: string): Promise<string>;
  readWorkspaceFile(path: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface HarnessDriverOptions {
  workspaceMode?: WorkspaceMode;
  allowedCommands?: readonly string[];
  allowShell?: boolean;
}

const DEFAULT_ALLOWED_COMMANDS = ["node"] as const;

export async function createSeedWorkspace(): Promise<SeedWorkspace> {
  const workspace = await createTempWorkspace("agent-container-e2e-");
  await writeWorkspaceFiles(workspace.root, {
    ".env": "PLAYGROUND_MODE=demo\nPLAYGROUND_SECRET_TOKEN=top-secret-token\n",
    "README.md": "# E2E Workspace\n\nThis workspace exercises agent-container.\n",
    "notes/session.txt": "session-run=0\n",
  });
  return workspace;
}

export async function createHarnessDriver(
  seedWorkspace: SeedWorkspace,
  options: HarnessDriverOptions = {},
): Promise<HarnessDriver> {
  const events: ObservabilityEvent[] = [];
  const container = await createAgentContainer({
    workspace: {
      root: seedWorkspace.root,
      mode: options.workspaceMode ?? "shadow",
    },
    env: {
      include: ["PLAYGROUND_*"],
      processEnv: "none",
    },
    exec: {
      allowedCommands: options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS,
      allowShell: options.allowShell ?? false,
      defaultTimeoutMs: 10_000,
    },
    network: {
      allowFetch: false,
    },
    observability: {
      emit(event) {
        events.push(event);
      },
    },
  });

  await container.start();
  const session = await container.createWorkerdSession();
  await session.start();

  return {
    container,
    session,
    get events() {
      return events;
    },
    async run(code: string, env?: Record<string, string>): Promise<WorkerdRunResult> {
      return await session.run({
        code,
        env,
        timeoutMs: 10_000,
      });
    },
    async readSeedFile(path: string): Promise<string> {
      return await readFile(join(seedWorkspace.root, path), "utf8");
    },
    async readWorkspaceFile(path: string): Promise<string> {
      return await container.workspace.readText(path);
    },
    async dispose(): Promise<void> {
      await session.stop();
      await container.stop();
    },
  };
}
