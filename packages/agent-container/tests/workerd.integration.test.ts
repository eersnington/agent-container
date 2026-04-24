import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentContainer, WorkerdRunError } from "agent-container";
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from "@agent-container/test-utils";

interface WorkerdResource {
  workspace: TempWorkspace;
  container?: Awaited<ReturnType<typeof createAgentContainer>>;
}

const resources = new Set<WorkerdResource>();

const addWasmModule = Uint8Array.from(
  Buffer.from("0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b", "hex"),
);

async function disposeWorkerdResource(resource: WorkerdResource): Promise<void> {
  if (resource.container !== undefined) {
    await resource.container.stop();
  }

  await resource.workspace.dispose();
}

afterEach(async () => {
  const trackedResources = [...resources];
  resources.clear();
  await Promise.allSettled(trackedResources.map(disposeWorkerdResource));
});

async function createTestContainer(files: Record<string, string>): Promise<{
  container: Awaited<ReturnType<typeof createAgentContainer>>;
  workspace: TempWorkspace;
}> {
  const workspace = await createTempWorkspace("agent-container-workerd-");
  await writeWorkspaceFiles(workspace.root, files);
  const container = await createAgentContainer({
    workspace: {
      root: workspace.root,
      mode: "live",
    },
    env: {
      include: ["PUBLIC_*"],
      processEnv: "none",
    },
    exec: {
      allowedCommands: ["node"],
    },
    network: {
      allowFetch: false,
    },
  });
  resources.add({ workspace, container });
  await container.start();
  return { container, workspace };
}

describe("workerd module execution", () => {
  it("runs JavaScript, TypeScript, and TSX code sources through the export contract", async () => {
    const { container } = await createTestContainer({});
    const session = await container.createWorkerdSession();

    await expect(
      session.run("export function run() { return 'js-ok'; }", { language: "js" }),
    ).resolves.toMatchObject({ result: "js-ok" });

    await expect(
      session.run("export function run(): number { const value: number = 42; return value; }", {
        language: "ts",
      }),
    ).resolves.toMatchObject({ result: 42 });

    await expect(
      session.run(
        `
            function h(type: string): { type: string } {
              return { type };
            }

            export function run(): string {
              const value = <span>tsx-ok</span>;
              return value.type;
            }
          `,
        {
          language: "tsx",
        },
      ),
    ).resolves.toMatchObject({ result: "span" });
  });

  it("runs workspace path sources with preserved relative module imports", async () => {
    const { container } = await createTestContainer({
      "src/data.json": "{\"name\":\"agent-container\"}\n",
      "src/message.txt": "hello-text",
      "src/util.ts": "export function label(value: string): string { return `label:${value}`; }\n",
      "src/task.ts": `
        import data from "./data.json";
        import message from "./message.txt";
        import { label } from "./util";

        export function run({ env }: { env: Record<string, string> }) {
          return {
            name: data.name,
            message,
            label: label(env.value),
          };
        }
      `,
    });
    const session = await container.createWorkerdSession();

    await expect(
      session.run({ path: "src/task.ts" }, {
        env: { value: "ok" },
      }),
    ).resolves.toMatchObject({
      result: {
        name: "agent-container",
        message: "hello-text",
        label: "label:ok",
      },
    });
  });

  it("passes structured invocation input to module runs", async () => {
    const { container } = await createTestContainer({
      "README.md": "structured input\n",
      "src/task.ts": `
        export async function run({ input, WORKSPACE }: { input: { path: string }, WORKSPACE: { readText(path: string): Promise<string> } }) {
          return await WORKSPACE.readText(input.path);
        }
      `,
    });
    const session = await container.createWorkerdSession();

    await expect(
      session.run(
        { path: "src/task.ts" },
        {
          input: { path: "README.md" },
        },
      ),
    ).resolves.toMatchObject({ result: "structured input\n" });
  });

  it("supports custom export names and capability bindings through ctx", async () => {
    const { container } = await createTestContainer({
      ".env": "PUBLIC_MODE=demo\n",
      "README.md": "hello workspace\n",
      "src/task.ts": `
        export async function inspect({ WORKSPACE, ENV, OBSERVE }) {
          await OBSERVE.emit({ scope: "workspace", action: "inspect", outcome: "success" });
          return {
            readme: await WORKSPACE.readText("README.md"),
            mode: await ENV.get("PUBLIC_MODE"),
          };
        }
      `,
    });
    const session = await container.createWorkerdSession();

    await expect(
      session.run({ path: "src/task.ts" }, {
        exportName: "inspect",
      }),
    ).resolves.toMatchObject({
      result: {
        readme: "hello workspace\n",
        mode: "demo",
      },
    });
  });

  it("rejects unsupported imports and missing callable exports with clear errors", async () => {
    const { container } = await createTestContainer({
      "src/bare.ts": "import leftPad from 'left-pad'; export function run() { return leftPad; }",
      "src/dynamic.ts": "export async function run() { return await import('./other.js'); }",
      "src/value.ts": "export const value = 1;",
    });
    const session = await container.createWorkerdSession();

    await expect(
      session.run({ path: "src/bare.ts" }),
    ).rejects.toThrow("Only static relative imports are supported");
    await expect(
      session.run({ path: "src/dynamic.ts" }),
    ).rejects.toThrow("Dynamic imports are not supported");
    await expect(
      session.run({ path: "src/value.ts" }),
    ).rejects.toThrow("Module must export a run(ctx) function or a default function.");
  });

  it("imports native wasm modules through workerd", async () => {
    const { container, workspace } = await createTestContainer({
      "src/task.ts": `
        import addModule from "./add.wasm";

        export async function run() {
          const instance = await WebAssembly.instantiate(addModule);
          const add = instance.exports.add as (left: number, right: number) => number;
          return add(2, 3);
        }
      `,
    });
    await writeFile(join(workspace.root, "src/add.wasm"), addWasmModule);
    const session = await container.createWorkerdSession();

    await expect(session.run({ path: "src/task.ts" })).resolves.toMatchObject({ result: 5 });
  });

  it("rejects path source escapes before module generation", async () => {
    const { container } = await createTestContainer({});
    const session = await container.createWorkerdSession();

    await expect(session.run({ path: "../outside.ts" })).rejects.toThrow("Path escapes workspace root");
  });

  it("preserves guest error name, stack, and logs", async () => {
    const { container } = await createTestContainer({});
    const session = await container.createWorkerdSession();

    let caught: unknown;
    try {
      await session.run(`
        export function run({ console }) {
          console.log("before failure");
          throw new TypeError("bad input");
        }
      `);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WorkerdRunError);
    const error = caught as WorkerdRunError;
    expect(error.message).toBe("bad input");
    expect(error.guestName).toBe("TypeError");
    expect(error.guestStack).toContain("TypeError: bad input");
    expect(error.logs).toEqual(["before failure"]);
  });
});
