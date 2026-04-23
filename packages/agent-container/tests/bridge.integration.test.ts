import { afterEach, describe, expect, it } from "vitest";

import {
  LocalCapabilityBridgeServer,
  LocalExecController,
  LocalWorkspaceController,
  resolveEnv,
} from "agent-container";
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from "@agent-container/test-utils";
import type { ObservabilityEvent } from "@agent-container/types";

interface BridgeResource {
  workspace: TempWorkspace;
  controller?: LocalWorkspaceController;
  bridge?: LocalCapabilityBridgeServer;
}

const resources = new Set<BridgeResource>();

async function disposeBridgeResource(resource: BridgeResource): Promise<void> {
  if (resource.bridge !== undefined) {
    await resource.bridge.stop();
  }

  if (resource.controller !== undefined) {
    await resource.controller.dispose();
  }

  await resource.workspace.dispose();
}

afterEach(async () => {
  const trackedResources = [...resources];
  resources.clear();
  await Promise.allSettled(trackedResources.map(disposeBridgeResource));
});

async function postJson(options: {
  port: number;
  token?: string;
  path: string;
  body?: unknown;
  method?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers["x-agent-container-bridge-token"] = options.token;
  }

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

describe("bridge integration", () => {
  it("brokers workspace, env, and exec calls over real HTTP", async () => {
    const workspaceRoot = await createTempWorkspace("agent-container-bridge-");
    await writeWorkspaceFiles(workspaceRoot.root, {
      ".env": "PUBLIC_MODE=demo\nAPI_SECRET_TOKEN=top-secret\n",
      "README.md": "hello\n",
    });

    const workspace = await LocalWorkspaceController.create({
      root: workspaceRoot.root,
      mode: "live",
    });
    const env = await resolveEnv(workspaceRoot.root, {
      include: ["PUBLIC_*", "API_SECRET_*"],
      processEnv: "none",
    });
    const exec = new LocalExecController({
      workspace,
      env,
      policy: {
        allowedCommands: ["node"],
      },
    });

    const events: ObservabilityEvent[] = [];
    const bridge = await LocalCapabilityBridgeServer.create(
      { workspace, env, exec },
      async (event) => {
        events.push({ timestamp: new Date().toISOString(), ...event });
      },
    );
    resources.add({ workspace: workspaceRoot, controller: workspace, bridge });

    const writeResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/workspace/write-text",
      body: { path: "notes/output.txt", text: "saved\n" },
    });
    expect(writeResponse.status).toBe(200);

    const readResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/workspace/read-text",
      body: { path: "notes/output.txt" },
    });
    expect(await readResponse.json()).toEqual({ result: "saved\n" });

    const envKeysResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/env/keys",
      body: { classification: "public" },
    });
    expect(await envKeysResponse.json()).toEqual({ result: ["PUBLIC_MODE"] });

    const envGetResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/env/get",
      body: { name: "PUBLIC_MODE", classification: "public" },
    });
    expect(await envGetResponse.json()).toEqual({ result: "demo" });

    const execResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/exec/run",
      body: {
        options: {
          command: "node",
          args: ["-e", "process.stdout.write(process.env.PUBLIC_MODE ?? 'missing')"],
          envKeys: ["PUBLIC_MODE"],
        },
      },
    });
    expect(await execResponse.json()).toEqual({
      result: {
        exitCode: 0,
        stdout: "demo",
        stderr: "",
        timedOut: false,
        durationMs: expect.any(Number),
      },
    });

    expect(events.some((event) => event.scope === "env" && event.action === "public.keys")).toBe(
      true,
    );
  });

  it("rejects invalid requests and unavailable capabilities", async () => {
    const workspaceRoot = await createTempWorkspace("agent-container-bridge-errors-");
    await writeWorkspaceFiles(workspaceRoot.root, {
      "README.md": "bridge\n",
    });
    const workspace = await LocalWorkspaceController.create({
      root: workspaceRoot.root,
      mode: "live",
    });
    const bridge = await LocalCapabilityBridgeServer.create({ workspace });
    resources.add({ workspace: workspaceRoot, controller: workspace, bridge });

    const wrongMethodResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/workspace/read-text",
      method: "GET",
    });
    expect(wrongMethodResponse.status).toBe(405);

    const missingTokenResponse = await postJson({
      port: bridge.port,
      path: "/workspace/read-text",
      body: { path: "README.md" },
    });
    expect(missingTokenResponse.status).toBe(401);

    const unknownRouteResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/unknown",
      body: {},
    });
    expect(unknownRouteResponse.status).toBe(404);

    const malformedBodyResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/workspace/write-text",
      body: { path: "README.md", text: 123 },
    });
    expect(malformedBodyResponse.status).toBe(400);

    const missingCapabilityResponse = await postJson({
      port: bridge.port,
      token: bridge.token,
      path: "/exec/run",
      body: { options: { command: "node" } },
    });
    expect(missingCapabilityResponse.status).toBe(403);
  });
});
