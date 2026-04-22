import { afterEach, describe, expect, it } from "vitest";

import { createAgentContainer, defineAgentContainerPlugin } from "agent-container";
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from "@agent-container/test-utils";
import type { ObservabilityEvent, WorkerdSession } from "@agent-container/types";

interface TestResource {
  workspace: TempWorkspace;
  container?: Awaited<ReturnType<typeof createAgentContainer>>;
  session?: WorkerdSession;
}

const resources = new Set<TestResource>();

afterEach(async () => {
  for (const resource of resources) {
    if (resource.session !== undefined) {
      await resource.session.stop();
    }
    if (resource.container !== undefined) {
      await resource.container.stop();
    }
    await resource.workspace.dispose();
    resources.delete(resource);
  }
});

describe("container surface", () => {
  it("assembles the real container surface and reports accurate defaults", async () => {
    const workspace = await createTempWorkspace("agent-container-surface-");
    await writeWorkspaceFiles(workspace.root, {
      ".env": "PUBLIC_MODE=demo\nAPI_SECRET_TOKEN=top-secret\n",
      "README.md": "# Container Surface\n",
    });

    const events: ObservabilityEvent[] = [];
    const container = await createAgentContainer({
      workspace: {
        root: workspace.root,
        mode: "shadow",
      },
      env: {
        include: ["PUBLIC_*", "API_SECRET_*"],
        processEnv: "none",
      },
      exec: {
        allowedCommands: ["node"],
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
    const resource: TestResource = { workspace, container };
    resources.add(resource);

    await container.start();
    await container.start();

    const description = container.describe();
    expect(description.workspaceMode).toBe("shadow");
    expect(description.bindings).toEqual(["WORKSPACE", "EXEC", "ENV", "SECRETS", "OBSERVE"]);
    expect(description.hasEnvPolicy).toBe(true);
    expect(description.hasExecPolicy).toBe(true);
    expect(description.hasNetworkPolicy).toBe(true);
    expect(description.envPublicKeys).toEqual(["PUBLIC_MODE"]);
    expect(description.envSecretKeys).toEqual(["API_SECRET_TOKEN"]);
    expect(await container.workspace.readText("README.md")).toBe("# Container Surface\n");

    const session = await container.createWorkerdSession({ allowFetch: true });
    resource.session = session;
    expect(session.status).toBe("created");

    const plugin = defineAgentContainerPlugin({
      name: "demo",
      container: {
        workspace: {
          root: workspace.root,
        },
      },
      tools: {
        bash: "EXEC.shell",
      },
    });
    expect(plugin.capabilities).toEqual(["WORKSPACE", "EXEC", "ENV", "SECRETS", "OBSERVE"]);
    expect(plugin.tools).toEqual({
      read: "WORKSPACE.read",
      write: "WORKSPACE.write",
      glob: "WORKSPACE.glob",
      grep: "WORKSPACE.grep",
      bash: "EXEC.shell",
    });

    expect(events.some((event) => event.scope === "env" && event.action === "resolve")).toBe(true);
    expect(events.some((event) => event.scope === "container" && event.action === "start")).toBe(true);
  });
});
