import {
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHarnessDriver,
  createSeedWorkspace,
  type HarnessDriver,
  type SeedWorkspace,
} from "./harness-driver.js";

interface PiResource {
  seedWorkspace?: SeedWorkspace;
  driver?: HarnessDriver;
  session?: AgentSession;
  faux?: FauxProviderRegistration;
}

const resources = new Set<PiResource>();

type TextContentBlock = { type: string; text?: string };

type MessageWithContent = {
  role: string;
  content: string | readonly TextContentBlock[];
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasMessageContent(value: unknown): value is MessageWithContent {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    typeof value.role === "string" &&
    "content" in value &&
    (typeof value.content === "string" || Array.isArray(value.content))
  );
}

function readTextContent(message: MessageWithContent): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function readAssistantText(session: AgentSession): string {
  const assistantMessages: string[] = [];
  for (const message of session.messages) {
    if (!hasMessageContent(message) || message.role !== "assistant") {
      continue;
    }

    assistantMessages.push(readTextContent(message));
  }

  return assistantMessages.join("\n");
}

async function disposePiResource(resource: PiResource): Promise<void> {
  resource.session?.dispose();
  resource.faux?.unregister();

  if (resource.driver !== undefined) {
    await resource.driver.dispose();
  }

  if (resource.seedWorkspace !== undefined) {
    await resource.seedWorkspace.dispose();
  }
}

afterEach(async () => {
  const trackedResources = [...resources];
  resources.clear();
  await Promise.allSettled(trackedResources.map(disposePiResource));
});

async function runSandboxValue<T>(options: {
  driver: HarnessDriver;
  code: string;
  env: Record<string, string>;
  validate: (value: unknown) => value is T;
  description: string;
}): Promise<T> {
  const execution = await options.driver.run(options.code, options.env);
  if (!options.validate(execution.result)) {
    throw new Error(
      `Expected ${options.description} from sandbox, received ${JSON.stringify(execution.result)}. Logs: ${execution.logs.join(" | ")}`,
    );
  }

  return execution.result;
}

async function createPiSessionHarness(driver: HarnessDriver): Promise<{
  faux: FauxProviderRegistration;
  session: AgentSession;
  toolRuns: string[];
}> {
  const faux = registerFauxProvider();
  const model = faux.getModel();
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "faux-key");
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "faux-key",
    api: faux.api,
    models: faux.models.map((registeredModel) => ({
      id: registeredModel.id,
      name: registeredModel.name,
      api: registeredModel.api,
      reasoning: registeredModel.reasoning,
      input: registeredModel.input,
      cost: registeredModel.cost,
      contextWindow: registeredModel.contextWindow,
      maxTokens: registeredModel.maxTokens,
      baseUrl: registeredModel.baseUrl,
    })),
  });

  const toolRuns: string[] = [];
  const commandToolResult = (text: string, outcome: "success" | "denied") => ({
    content: [{ type: "text" as const, text }],
    details: { outcome },
  });
  const listFilesTool = defineTool({
    name: "list_files",
    label: "List Files",
    description: "List files in the sandboxed workspace.",
    promptSnippet: "List files in the sandboxed workspace",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_toolCallId, params) => {
      toolRuns.push("list_files");
      const files = await runSandboxValue({
        driver,
        code: "const entries = await WORKSPACE.list(env.path); return entries.map((entry) => entry.path);",
        env: { path: params.path },
        validate: isStringArray,
        description: "a list of file paths",
      });
      return {
        content: [{ type: "text", text: files.join("\n") }],
        details: { count: files.length },
      };
    },
  });
  const readFileTool = defineTool({
    name: "read_file",
    label: "Read File",
    description: "Read a text file from the sandboxed workspace.",
    promptSnippet: "Read text files from the sandboxed workspace",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_toolCallId, params) => {
      toolRuns.push("read_file");
      const text = await runSandboxValue({
        driver,
        code: "return await WORKSPACE.readText(env.path);",
        env: { path: params.path },
        validate: isString,
        description: "file text",
      });
      return {
        content: [{ type: "text", text }],
        details: { path: params.path },
      };
    },
  });
  const writeFileTool = defineTool({
    name: "write_file",
    label: "Write File",
    description: "Write a text file into the sandboxed workspace.",
    promptSnippet: "Write text files into the sandboxed workspace",
    parameters: Type.Object({ path: Type.String(), text: Type.String() }),
    execute: async (_toolCallId, params) => {
      toolRuns.push("write_file");
      const writtenPath = await runSandboxValue({
        driver,
        code: "await WORKSPACE.writeText(env.path, env.text); return env.path;",
        env: { path: params.path, text: params.text },
        validate: isString,
        description: "written path",
      });
      return {
        content: [{ type: "text", text: `wrote:${writtenPath}` }],
        details: { path: writtenPath },
      };
    },
  });
  const runNodeTool = defineTool({
    name: "run_node",
    label: "Run Node",
    description: "Run a Node.js snippet inside the sandboxed workspace.",
    promptSnippet: "Run Node.js snippets in the sandboxed workspace",
    parameters: Type.Object({ script: Type.String() }),
    execute: async (_toolCallId, params) => {
      toolRuns.push("run_node");
      const stdout = await runSandboxValue({
        driver,
        code: `const result = await EXEC.run({ command: "node", args: ["-e", env.script], envKeys: ["PLAYGROUND_MODE"] }); return result.stdout;`,
        env: { script: params.script },
        validate: isString,
        description: "command stdout",
      });
      return {
        content: [{ type: "text", text: stdout }],
        details: { stdout },
      };
    },
  });
  const runCommandTool = defineTool({
    name: "run_command",
    label: "Run Command",
    description: "Run an allowed command inside the sandboxed workspace.",
    promptSnippet: "Run an allowed command inside the sandboxed workspace",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_toolCallId, params) => {
      toolRuns.push("run_command");

      try {
        const stdout = await runSandboxValue({
          driver,
          code: "const result = await EXEC.run({ command: env.command }); return result.stdout;",
          env: { command: params.command },
          validate: isString,
          description: "command stdout",
        });
        return commandToolResult(stdout, "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return commandToolResult(message, "denied");
      }
    },
  });

  const { session } = await createAgentSession({
    cwd: driver.container.workspace.root,
    agentDir: driver.container.workspace.root,
    model,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    customTools: [listFilesTool, readFileTool, writeFileTool, runNodeTool, runCommandTool],
  });
  await session.bindExtensions({});
  session.setActiveToolsByName(["list_files", "read_file", "write_file", "run_node", "run_command"]);

  return { faux, session, toolRuns };
}

describe("pi sdk e2e", () => {
  it("routes Pi SDK tool calls through a real workerd-backed container session", async () => {
    const seedWorkspace = await createSeedWorkspace();
    const driver = await createHarnessDriver(seedWorkspace);
    const { faux, session, toolRuns } = await createPiSessionHarness(driver);
    const resource: PiResource = { seedWorkspace, driver, session, faux };
    resources.add(resource);

    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("list_files", { path: "." }, { id: "tool-list" }),
          fauxToolCall("read_file", { path: "README.md" }, { id: "tool-read" }),
          fauxToolCall(
            "write_file",
            {
              path: "notes/pi-summary.txt",
              text: "Pi SDK wrote this file through agent-container.\n",
            },
            { id: "tool-write" },
          ),
          fauxToolCall(
            "run_node",
            { script: 'process.stdout.write(process.env.PLAYGROUND_MODE ?? "missing")' },
            { id: "tool-exec" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Completed the sandbox workspace check."),
    ]);

    await session.prompt("Inspect the sandboxed workspace, write a summary file, and verify the runtime mode.");

    expect(toolRuns.sort()).toEqual(["list_files", "read_file", "run_node", "write_file"]);
    expect(readAssistantText(session)).toContain("Completed the sandbox workspace check.");
    expect(await driver.readWorkspaceFile("notes/pi-summary.txt")).toBe(
      "Pi SDK wrote this file through agent-container.\n",
    );
    await expect(driver.readSeedFile("notes/pi-summary.txt")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await driver.readSeedFile("notes/session.txt")).toBe("session-run=0\n");

    expect(driver.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "workspace", action: "list", outcome: "success" }),
        expect.objectContaining({ scope: "workspace", action: "read", outcome: "success", target: "README.md" }),
        expect.objectContaining({ scope: "workspace", action: "write", outcome: "success", target: "notes/pi-summary.txt" }),
        expect.objectContaining({ scope: "exec", action: "run", outcome: "success", target: "node" }),
      ]),
    );
  });

  it("surfaces container policy denials back through the Pi SDK tool layer", async () => {
    const seedWorkspace = await createSeedWorkspace();
    const driver = await createHarnessDriver(seedWorkspace);
    const { faux, session, toolRuns } = await createPiSessionHarness(driver);
    const resource: PiResource = { seedWorkspace, driver, session, faux };
    resources.add(resource);

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("run_command", { command: "python3" }, { id: "tool-denied" }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const toolMessage = context.messages.find((message) => message.role === "toolResult");
        const denial =
          toolMessage?.role === "toolResult" && hasMessageContent(toolMessage)
            ? readTextContent(toolMessage)
            : "missing tool result";
        return fauxAssistantMessage(`Observed denial: ${denial}`);
      },
    ]);

    await session.prompt("Try to run python3 and report whether the sandbox policy blocked it.");

    expect(toolRuns).toEqual(["run_command"]);
    expect(readAssistantText(session)).toContain("Command is not allowed: python3");
    expect(driver.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "exec", action: "run-denied", outcome: "denied", target: "python3" }),
      ]),
    );
  });
});
