import type { Dirent } from "node:fs";
import {
  cp,
  glob,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type {
  MountAccessMode,
  ObservabilityEvent,
  WorkspaceController,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceOptions,
  WorkspaceSearchResult,
} from "@agent-container/types";

interface MountBinding {
  mountPath: string;
  sourcePath: string;
  mode: MountAccessMode;
}

interface ResolvedTarget {
  logicalPath: string;
  physicalPath: string;
}

type EmitEvent = (event: Omit<ObservabilityEvent, "timestamp">) => Promise<void>;

function normalizeMountPath(value: string): string {
  if (value === "" || value === "/") {
    return "/";
  }

  const withSlashes = value.replace(/\\/gu, "/");
  const withLeadingSlash = withSlashes.startsWith("/") ? withSlashes : `/${withSlashes}`;
  return withLeadingSlash.replace(/\/+$/gu, "");
}

function normalizeLogicalPath(value: string | undefined): string {
  if (value === undefined || value === "" || value === "." || value === "/") {
    return ".";
  }

  const normalized = value.replace(/\\/gu, "/");
  if (normalized.startsWith("./")) {
    return normalizeLogicalPath(normalized.slice(2));
  }

  return normalized;
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  if (targetPath === rootPath) {
    return true;
  }

  return targetPath.startsWith(`${rootPath}${sep}`);
}

function toWorkspaceEntry(kind: WorkspaceEntryKind, size: number, path: string): WorkspaceEntry {
  return { path, kind, size };
}

async function canonicalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function entryKindFromDirent(entry: Dirent): WorkspaceEntryKind {
  if (entry.isFile()) {
    return "file";
  }

  if (entry.isDirectory()) {
    return "directory";
  }

  if (entry.isSymbolicLink()) {
    return "symlink";
  }

  return "other";
}

function entryKindFromStat(
  isFile: boolean,
  isDirectory: boolean,
  isSymbolicLink: boolean,
): WorkspaceEntryKind {
  if (isFile) {
    return "file";
  }

  if (isDirectory) {
    return "directory";
  }

  if (isSymbolicLink) {
    return "symlink";
  }

  return "other";
}

export class LocalWorkspaceController implements WorkspaceController {
  public readonly root: string;

  public readonly mode: "live" | "shadow";

  readonly #mounts: readonly MountBinding[];

  readonly #emit: EmitEvent | undefined;

  readonly #shadowRoot: string | undefined;

  private constructor(options: {
    root: string;
    mode: "live" | "shadow";
    mounts: readonly MountBinding[];
    shadowRoot?: string;
    emit?: EmitEvent;
  }) {
    this.root = options.root;
    this.mode = options.mode;
    this.#mounts = options.mounts;
    this.#shadowRoot = options.shadowRoot;
    this.#emit = options.emit;
  }

  public static async create(
    options: WorkspaceOptions,
    emit?: EmitEvent,
  ): Promise<LocalWorkspaceController> {
    const workspaceRoot = resolve(options.root);
    const mode = options.mode ?? "live";

    let activeRoot = workspaceRoot;
    let shadowRoot: string | undefined;
    if (mode === "shadow") {
      const shadowParent = await mkdtemp(resolve(tmpdir(), "agent-container-shadow-"));
      shadowRoot = join(shadowParent, basename(workspaceRoot));
      await cp(workspaceRoot, shadowRoot, { recursive: true });
      activeRoot = shadowRoot;
    }

    const mounts: MountBinding[] = [
      {
        mountPath: "/",
        sourcePath: activeRoot,
        mode: "rw",
      },
    ];

    for (const mount of options.mounts ?? []) {
      mounts.push({
        mountPath: normalizeMountPath(mount.mountPath),
        sourcePath: resolve(mount.sourcePath),
        mode: mount.mode,
      });
    }

    mounts.sort((left, right) => right.mountPath.length - left.mountPath.length);

    return new LocalWorkspaceController({
      root: activeRoot,
      mode,
      mounts,
      shadowRoot,
      emit,
    });
  }

  public async read(path: string): Promise<Uint8Array> {
    const target = await this.#resolveTarget(path);
    const content = await readFile(target.physicalPath);
    await this.#emitEvent({
      scope: "workspace",
      action: "read",
      outcome: "success",
      target: target.logicalPath,
      detail: `${content.byteLength} bytes`,
    });
    return content;
  }

  public async readText(path: string): Promise<string> {
    const content = await this.read(path);
    return Buffer.from(content).toString("utf8");
  }

  public async write(path: string, content: string | Uint8Array): Promise<void> {
    const target = await this.#resolveTarget(path, { requireWritable: true });
    await mkdir(dirname(target.physicalPath), { recursive: true });
    await writeFile(target.physicalPath, content);
    await this.#emitEvent({
      scope: "workspace",
      action: "write",
      outcome: "success",
      target: target.logicalPath,
    });
  }

  public async list(path: string = "."): Promise<readonly WorkspaceEntry[]> {
    const target = await this.#resolveTarget(path);
    const entries = await readdir(target.physicalPath, { withFileTypes: true });
    const result: WorkspaceEntry[] = [];

    for (const entry of entries) {
      const childPhysicalPath = resolve(target.physicalPath, entry.name);
      const childStat = await lstat(childPhysicalPath);
      const childLogicalPath =
        target.logicalPath === "."
          ? entry.name
          : `${target.logicalPath.replace(/\/$/u, "")}/${entry.name}`;
      result.push(toWorkspaceEntry(entryKindFromDirent(entry), childStat.size, childLogicalPath));
    }

    await this.#emitEvent({
      scope: "workspace",
      action: "list",
      outcome: "success",
      target: target.logicalPath,
      detail: `${result.length} entries`,
    });

    return result;
  }

  public async stat(path: string): Promise<WorkspaceEntry> {
    const target = await this.#resolveTarget(path);
    const entryStat = await lstat(target.physicalPath);
    const entry = toWorkspaceEntry(
      entryKindFromStat(
        entryStat.isFile(),
        entryStat.isDirectory(),
        entryStat.isSymbolicLink(),
      ),
      entryStat.size,
      target.logicalPath,
    );
    await this.#emitEvent({
      scope: "workspace",
      action: "stat",
      outcome: "success",
      target: target.logicalPath,
    });
    return entry;
  }

  public async glob(pattern: string | readonly string[]): Promise<readonly string[]> {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    const matches = new Set<string>();

    for (const mount of this.#mounts) {
      for await (const entry of glob(patterns, { cwd: mount.sourcePath })) {
        const normalizedEntry = entry.replace(/\\/gu, "/");
        const logicalPath =
          mount.mountPath === "/" ? normalizedEntry : `${mount.mountPath}/${normalizedEntry}`;
        matches.add(logicalPath === "" ? "." : logicalPath);
      }
    }

    const sortedMatches = [...matches].sort();
    await this.#emitEvent({
      scope: "workspace",
      action: "glob",
      outcome: "success",
      detail: `${sortedMatches.length} matches`,
    });
    return sortedMatches;
  }

  public async grep(
    query: string,
    options?: {
      include?: string | readonly string[];
      caseSensitive?: boolean;
      maxResults?: number;
    },
  ): Promise<readonly WorkspaceSearchResult[]> {
    const include = options?.include ?? "**/*";
    const paths = await this.glob(include);
    const matches: WorkspaceSearchResult[] = [];
    const caseSensitive = options?.caseSensitive ?? true;
    const maxResults = options?.maxResults ?? Number.POSITIVE_INFINITY;
    const normalizedQuery = caseSensitive ? query : query.toLowerCase();

    for (const path of paths) {
      const entry = await this.stat(path);
      if (entry.kind !== "file") {
        continue;
      }

      const content = await this.readText(path);
      const lines = content.split(/\r?\n/u);
      for (const [index, line] of lines.entries()) {
        const haystack = caseSensitive ? line : line.toLowerCase();
        const column = haystack.indexOf(normalizedQuery);
        if (column === -1) {
          continue;
        }

        matches.push({
          path,
          line: index + 1,
          column: column + 1,
          content: line,
        });

        if (matches.length >= maxResults) {
          await this.#emitEvent({
            scope: "workspace",
            action: "grep",
            outcome: "success",
            detail: `${matches.length} matches`,
          });
          return matches;
        }
      }
    }

    await this.#emitEvent({
      scope: "workspace",
      action: "grep",
      outcome: "success",
      detail: `${matches.length} matches`,
    });

    return matches;
  }

  public async remove(path: string): Promise<void> {
    const target = await this.#resolveTarget(path, { requireWritable: true });
    await rm(target.physicalPath, { recursive: true, force: true });
    await this.#emitEvent({
      scope: "workspace",
      action: "remove",
      outcome: "success",
      target: target.logicalPath,
    });
  }

  public async resolvePath(path: string): Promise<string> {
    const target = await this.#resolveTarget(path);
    return target.physicalPath;
  }

  public async dispose(): Promise<void> {
    if (this.#shadowRoot !== undefined) {
      await rm(dirname(this.#shadowRoot), { recursive: true, force: true });
    }
  }

  async #resolveTarget(
    path: string,
    options?: { requireWritable?: boolean },
  ): Promise<ResolvedTarget> {
    const logicalPath = normalizeLogicalPath(path);
    const normalizedForMatch = logicalPath === "." ? "/" : `/${stripLeadingSlash(logicalPath)}`;

    const mount = this.#mounts.find((candidate) => {
      if (candidate.mountPath === "/") {
        return true;
      }

      return (
        normalizedForMatch === candidate.mountPath ||
        normalizedForMatch.startsWith(`${candidate.mountPath}/`)
      );
    });

    if (mount === undefined) {
      throw new Error(`No workspace mount found for path: ${path}`);
    }

    if (options?.requireWritable === true && mount.mode !== "rw") {
      await this.#emitEvent({
        scope: "workspace",
        action: "write-denied",
        outcome: "denied",
        target: logicalPath,
      });
      throw new Error(`Path is not writable: ${path}`);
    }

    const relativeLogicalPath =
      mount.mountPath === "/"
        ? stripLeadingSlash(logicalPath)
        : stripLeadingSlash(normalizedForMatch.slice(mount.mountPath.length));
    const unresolvedPhysicalPath = resolve(mount.sourcePath, relativeLogicalPath);
    const canonicalRoot = await canonicalizeExistingPath(mount.sourcePath);
    const canonicalTarget = await canonicalizeExistingPath(unresolvedPhysicalPath);
    if (!isWithinRoot(canonicalTarget, canonicalRoot)) {
      throw new Error(`Path escapes workspace root: ${path}`);
    }

    return {
      logicalPath,
      physicalPath: unresolvedPhysicalPath,
    };
  }

  async #emitEvent(event: Omit<ObservabilityEvent, "timestamp">): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    await this.#emit(event);
  }
}
