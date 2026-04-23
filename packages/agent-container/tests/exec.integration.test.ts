import { realpath } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { LocalExecController, LocalWorkspaceController, resolveEnv } from "agent-container";
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from "@agent-container/test-utils";
import type { ObservabilityEvent } from "@agent-container/types";

interface ExecResource {
  workspace: TempWorkspace;
  controller?: LocalWorkspaceController;
}

const resources = new Set<ExecResource>();

async function disposeExecResource(resource: ExecResource): Promise<void> {
  if (resource.controller !== undefined) {
    await resource.controller.dispose();
  }

  await resource.workspace.dispose();
}

afterEach(async () => {
  const trackedResources = [...resources];
  resources.clear();
  await Promise.allSettled(trackedResources.map(disposeExecResource));
});

describe("exec integration", () => {
  it("uses workspace cwd and env policy when running real subprocesses", async () => {
    const workspaceRoot = await createTempWorkspace("agent-container-exec-");
    await writeWorkspaceFiles(workspaceRoot.root, {
      ".env": "PUBLIC_MODE=demo\nAPI_SECRET_TOKEN=top-secret\n",
      "subdir/marker.txt": "marker\n",
    });

    const workspace = await LocalWorkspaceController.create({
      root: workspaceRoot.root,
      mode: "live",
    });
    resources.add({ workspace: workspaceRoot, controller: workspace });
    const env = await resolveEnv(workspaceRoot.root, {
      include: ["PUBLIC_*", "API_SECRET_*"],
      processEnv: "none",
    });
    const exec = new LocalExecController({
      workspace,
      env,
      policy: {
        allowedCommands: ["node"],
        allowShell: false,
        defaultTimeoutMs: 10_000,
      },
    });

    const cwdResult = await exec.run({
      command: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
      cwd: "subdir",
    });
    expect(await realpath(cwdResult.stdout)).toBe(await realpath(await workspace.resolvePath("subdir")));

    const withoutSecrets = await exec.run({
      command: "node",
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({mode: process.env.PUBLIC_MODE ?? null, secret: process.env.API_SECRET_TOKEN ?? null, extra: process.env.EXTRA_FLAG ?? null}))",
      ],
      envKeys: ["PUBLIC_MODE", "API_SECRET_TOKEN"],
      env: { EXTRA_FLAG: "extra" },
    });
    expect(JSON.parse(withoutSecrets.stdout)).toEqual({
      mode: "demo",
      secret: null,
      extra: "extra",
    });

    const withSecrets = await exec.run({
      command: "node",
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({mode: process.env.PUBLIC_MODE ?? null, secret: process.env.API_SECRET_TOKEN ?? null}))",
      ],
      envKeys: ["PUBLIC_MODE", "API_SECRET_TOKEN"],
      includeSecrets: true,
    });
    expect(JSON.parse(withSecrets.stdout)).toEqual({
      mode: "demo",
      secret: "top-secret",
    });

    await expect(
      exec.run({
        command: "node",
        args: ["-e", "process.stdout.write('unused')"],
        env: { PATH: "/tmp/not-allowed" },
      }),
    ).rejects.toThrow("Environment variable is not allowed for exec: PATH");
  });

  it("denies disallowed commands and shell execution while emitting policy events", async () => {
    const workspaceRoot = await createTempWorkspace("agent-container-exec-policy-");
    const workspace = await LocalWorkspaceController.create({
      root: workspaceRoot.root,
      mode: "live",
    });
    resources.add({ workspace: workspaceRoot, controller: workspace });

    const events: ObservabilityEvent[] = [];
    const exec = new LocalExecController({
      workspace,
      env: await resolveEnv(workspaceRoot.root),
      policy: {
        allowedCommands: ["node"],
        allowShell: false,
      },
      emit: async (event) => {
        events.push({ timestamp: new Date().toISOString(), ...event });
      },
    });

    await expect(exec.run({ command: "python3" })).rejects.toThrow(
      "Command is not allowed: python3",
    );
    await expect(exec.shell({ script: "pwd" })).rejects.toThrow(
      "Shell execution is not allowed.",
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "exec",
          action: "run-denied",
          outcome: "denied",
          target: "python3",
        }),
        expect.objectContaining({
          scope: "exec",
          action: "shell-denied",
          outcome: "denied",
          target: "pwd",
        }),
      ]),
    );
  });
});
