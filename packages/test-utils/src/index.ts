export interface TempWorkspace {
  root: string;
  cleanup(): Promise<void>;
}

export async function createTempWorkspace(): Promise<TempWorkspace> {
  throw new Error("createTempWorkspace is not implemented yet in this incremental branch.");
}

export async function writeWorkspaceFiles(): Promise<void> {
  throw new Error("writeWorkspaceFiles is not implemented yet in this incremental branch.");
}
