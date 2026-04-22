import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempWorkspace {
  root: string;
  dispose(): Promise<void>;
}

export async function createTempWorkspace(
  prefix: string = "agent-container-",
): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), prefix));

  return {
    root,
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function writeWorkspaceFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    const directoryPath = dirname(filePath);
    await mkdir(directoryPath, { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
}
