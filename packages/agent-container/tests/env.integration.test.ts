import { afterEach, describe, expect, it } from "vitest";

import { resolveEnv } from "agent-container";
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from "@agent-container/test-utils";

const resources = new Set<TempWorkspace>();

afterEach(async () => {
  const workspaces = [...resources];
  resources.clear();
  await Promise.allSettled(workspaces.map(async (workspace) => workspace.dispose()));
});

describe("env integration", () => {
  it("merges real env sources, filters names, and hides secrets by default", async () => {
    const workspace = await createTempWorkspace("agent-container-env-");
    resources.add(workspace);
    await writeWorkspaceFiles(workspace.root, {
      ".env": "PUBLIC_MODE=file\nPUBLIC_FILE_ONLY=base\nAPI_SECRET_TOKEN=file-secret\n",
      ".env.local": "PUBLIC_MODE=local\nPUBLIC_LOCAL_ONLY=local\n",
    });

    const originalVisible = process.env.PROCESS_VISIBLE;
    const originalBlocked = process.env.PROCESS_BLOCKED;
    const originalSecret = process.env.API_SECRET_TOKEN;

    process.env.PROCESS_VISIBLE = "from-process";
    process.env.PROCESS_BLOCKED = "blocked";
    process.env.API_SECRET_TOKEN = "process-secret";

    try {
      const env = await resolveEnv(workspace.root, {
        include: ["PUBLIC_*", "PROCESS_*", "INLINE_*", "API_SECRET_*"],
        exclude: ["PROCESS_BLOCKED"],
        processEnv: "allow-matching",
        sources: [
          { type: "file", path: ".env" },
          { type: "file", path: ".env.local" },
          { type: "process" },
          {
            type: "inline",
            values: {
              PUBLIC_MODE: "inline",
              PUBLIC_READ_KEY: "public-key",
              INLINE_FLAG: "enabled",
              API_SECRET_TOKEN: "inline-secret",
            },
          },
        ],
      });

      const snapshot = env.snapshot();
      expect(snapshot.publicKeys).toEqual([
        "INLINE_FLAG",
        "PROCESS_VISIBLE",
        "PUBLIC_FILE_ONLY",
        "PUBLIC_LOCAL_ONLY",
        "PUBLIC_MODE",
        "PUBLIC_READ_KEY",
      ]);
      expect(snapshot.secretKeys).toEqual(["API_SECRET_TOKEN"]);
      expect(env.get("PUBLIC_MODE")).toBe("inline");
      expect(env.get("PUBLIC_READ_KEY")).toBe("public-key");
      expect(env.get("PROCESS_VISIBLE")).toBe("from-process");
      expect(env.get("PROCESS_BLOCKED")).toBeUndefined();
      expect(env.getClassification("API_SECRET_TOKEN")).toBe("secret");
      expect(env.toObject()).toEqual({
        INLINE_FLAG: "enabled",
        PROCESS_VISIBLE: "from-process",
        PUBLIC_FILE_ONLY: "base",
        PUBLIC_LOCAL_ONLY: "local",
        PUBLIC_MODE: "inline",
        PUBLIC_READ_KEY: "public-key",
      });
      expect(env.toObject({ includeSecrets: true })).toMatchObject({
        API_SECRET_TOKEN: "inline-secret",
        PUBLIC_MODE: "inline",
      });
    } finally {
      if (originalVisible === undefined) {
        delete process.env.PROCESS_VISIBLE;
      } else {
        process.env.PROCESS_VISIBLE = originalVisible;
      }

      if (originalBlocked === undefined) {
        delete process.env.PROCESS_BLOCKED;
      } else {
        process.env.PROCESS_BLOCKED = originalBlocked;
      }

      if (originalSecret === undefined) {
        delete process.env.API_SECRET_TOKEN;
      } else {
        process.env.API_SECRET_TOKEN = originalSecret;
      }
    }
  });

  it("discovers root env files by default and filters excluded private keys", async () => {
    const workspace = await createTempWorkspace("agent-container-env-default-sources-");
    resources.add(workspace);
    await writeWorkspaceFiles(workspace.root, {
      ".env": "PUBLIC_READ_KEY=hello-world\nPRIVATE_API_KEY=foobarbaz\n",
      ".env.prod": "PUBLIC_PROD_MODE=enabled\nPRIVATE_PROD_TOKEN=hidden\n",
      "nested/.env": "PUBLIC_NESTED_MODE=ignored\n",
    });

    const env = await resolveEnv(workspace.root, {
      include: ["PUBLIC_*"],
      processEnv: "none",
    });

    expect(env.snapshot().publicKeys).toEqual(["PUBLIC_PROD_MODE", "PUBLIC_READ_KEY"]);
    expect(env.snapshot().secretKeys).toEqual([]);
    expect(env.get("PUBLIC_READ_KEY")).toBe("hello-world");
    expect(env.get("PUBLIC_PROD_MODE")).toBe("enabled");
    expect(env.get("PRIVATE_API_KEY")).toBeUndefined();
    expect(env.get("PRIVATE_PROD_TOKEN")).toBeUndefined();
    expect(env.get("PUBLIC_NESTED_MODE")).toBeUndefined();
  });
});
