import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalWorkspaceController } from "agent-container";
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from "@agent-container/test-utils";
import type { ObservabilityEvent } from "@agent-container/types";

interface WorkspaceResource {
  workspaces: TempWorkspace[];
  controller?: LocalWorkspaceController;
}

const resources = new Set<WorkspaceResource>();

async function disposeWorkspaceResource(resource: WorkspaceResource): Promise<void> {
  if (resource.controller !== undefined) {
    await resource.controller.dispose();
  }

  await Promise.allSettled(resource.workspaces.map(async (workspace) => workspace.dispose()));
}

afterEach(async () => {
  const trackedResources = [...resources];
  resources.clear();
  await Promise.allSettled(trackedResources.map(disposeWorkspaceResource));
});

describe("workspace integration", () => {
  it("isolates shadow writes and removals from the seed workspace", async () => {
    const seedWorkspace = await createTempWorkspace("agent-container-workspace-seed-");
    await writeWorkspaceFiles(seedWorkspace.root, {
      "README.md": "seed readme\n",
      "notes/keep.txt": "keep\n",
      "notes/remove.txt": "remove me\n",
    });

    const workspace = await LocalWorkspaceController.create({
      root: seedWorkspace.root,
      mode: "shadow",
    });
    resources.add({ workspaces: [seedWorkspace], controller: workspace });

    await workspace.write("README.md", "shadow readme\n");
    await workspace.remove("notes/remove.txt");

    expect(await workspace.readText("README.md")).toBe("shadow readme\n");
    await expect(workspace.readText("notes/remove.txt")).rejects.toThrow("ENOENT");
    expect(await readFile(join(seedWorkspace.root, "README.md"), "utf8")).toBe("seed readme\n");
    expect(await readFile(join(seedWorkspace.root, "notes/remove.txt"), "utf8")).toBe("remove me\n");

    const resolvedPath = await workspace.resolvePath("README.md");
    expect(resolvedPath.startsWith(seedWorkspace.root)).toBe(false);
  });

  it("enforces mount and path boundary rules with real filesystem state", async () => {
    const rootWorkspace = await createTempWorkspace("agent-container-workspace-root-");
    const docsWorkspace = await createTempWorkspace("agent-container-workspace-docs-");
    const privateWorkspace = await createTempWorkspace("agent-container-workspace-private-");
    const externalWorkspace = await createTempWorkspace("agent-container-workspace-external-");

    await writeWorkspaceFiles(rootWorkspace.root, {
      "README.md": "root\n",
    });
    await writeWorkspaceFiles(docsWorkspace.root, {
      "read-only.txt": "docs\n",
    });
    await writeWorkspaceFiles(privateWorkspace.root, {
      "existing.txt": "private\n",
    });
    await writeWorkspaceFiles(externalWorkspace.root, {
      "secret.txt": "outside\n",
    });
    await symlink(externalWorkspace.root, join(rootWorkspace.root, "outside-link"));

    const events: ObservabilityEvent[] = [];
    const workspace = await LocalWorkspaceController.create(
      {
        root: rootWorkspace.root,
        mode: "live",
        mounts: [
          { mountPath: "/docs", sourcePath: docsWorkspace.root, mode: "ro" },
          { mountPath: "/docs/private", sourcePath: privateWorkspace.root, mode: "rw" },
        ],
      },
      async (event) => {
        events.push({ timestamp: new Date().toISOString(), ...event });
      },
    );
    resources.add({
      workspaces: [rootWorkspace, docsWorkspace, privateWorkspace, externalWorkspace],
      controller: workspace,
    });

    await workspace.write("docs/private/override.txt", "override\n");

    expect(await workspace.readText("docs/private/override.txt")).toBe("override\n");
    expect(await readFile(join(privateWorkspace.root, "override.txt"), "utf8")).toBe("override\n");
    await expect(workspace.write("docs/read-only.txt", "nope\n")).rejects.toThrow(
      "Path is not writable: docs/read-only.txt",
    );
    await expect(workspace.readText("../outside.txt")).rejects.toThrow(
      "Path escapes workspace root: ../outside.txt",
    );
    await expect(workspace.readText("outside-link/secret.txt")).rejects.toThrow(
      "Path escapes workspace root: outside-link/secret.txt",
    );
    expect(
      events.some((event) => event.scope === "workspace" && event.action === "write-denied"),
    ).toBe(true);
  });

  it("returns real query results for list, stat, glob, and grep", async () => {
    const workspaceRoot = await createTempWorkspace("agent-container-workspace-query-");
    await writeWorkspaceFiles(workspaceRoot.root, {
      "README.md": "Hello workspace\n",
      "src/alpha.ts": "export const hello = 1;\nexport const Hello = 2;\n",
      "src/nested/beta.ts": "export const world = 'hello';\n",
    });

    const workspace = await LocalWorkspaceController.create({
      root: workspaceRoot.root,
      mode: "live",
    });
    resources.add({ workspaces: [workspaceRoot], controller: workspace });

    const listedPaths = [...(await workspace.list("src"))].map((entry) => entry.path).sort();
    expect(listedPaths).toEqual(["src/alpha.ts", "src/nested"]);
    expect((await workspace.stat("src/nested")).kind).toBe("directory");
    expect(await workspace.glob(["src/**/*.ts", "README.md"])).toEqual([
      "README.md",
      "src/alpha.ts",
      "src/nested/beta.ts",
    ]);

    const grepResults = await workspace.grep("hello", {
      include: ["src/**/*.ts", "README.md"],
      caseSensitive: false,
      maxResults: 2,
    });

    expect(grepResults).toEqual([
      {
        path: "README.md",
        line: 1,
        column: 1,
        content: "Hello workspace",
      },
      {
        path: "src/alpha.ts",
        line: 1,
        column: 14,
        content: "export const hello = 1;",
      },
    ]);
  });
});
