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
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from "node:path";

import type {
  EnvPolicy,
  EnvSource,
  MountAccessMode,
  ObservabilityEvent,
  WorkspaceController,
  WorkspaceEntry,
  WorkspaceEntryKind,
  WorkspaceOptions,
  WorkspaceSearchResult,
} from "@agent-container/types";

import {
  filterEnvValues,
  parseEnvFile,
  type ResolvedEnvPolicy,
  resolveEnvPolicy,
  serializeEnvFile,
} from "./env.js";

interface MountBinding {
  mountPath: string;
  sourcePath: string;
  mode: MountAccessMode;
}

interface ResolvedTarget {
  logicalPath: string;
  physicalPath: string;
}

class WorkspaceWriteDeniedError extends Error {}

function isWorkspaceWriteDeniedError(error: unknown): error is WorkspaceWriteDeniedError {
  return error instanceof Error && error.name === "WorkspaceWriteDeniedError";
}

class WorkspaceReadDeniedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceReadDeniedError";
  }
}

function isWorkspaceReadDeniedError(error: unknown): error is WorkspaceReadDeniedError {
  return error instanceof Error && error.name === "WorkspaceReadDeniedError";
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

async function canonicalizeForContainment(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parentPath = dirname(path);
    if (parentPath === path) {
      return path;
    }

    const canonicalParent = await canonicalizeForContainment(parentPath);
    return join(canonicalParent, basename(path));
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

function sourceLogicalPath(
  root: string,
  source: Extract<EnvSource, { type: "file" }>,
): string | undefined {
  const sourcePath = resolve(root, source.path);
  const relativePath = relative(root, sourcePath);
  if (relativePath === "" || relativePath.startsWith("..") || relativePath.startsWith(`..${sep}`)) {
    return undefined;
  }

  return normalizeLogicalPath(relativePath.replace(/\\/gu, "/"));
}

export class LocalWorkspaceController implements WorkspaceController {
  public readonly root: string;

  public readonly mode: "live" | "shadow";

  readonly #mounts: readonly MountBinding[];

  readonly #emit: EmitEvent | undefined;

  readonly #shadowRoot: string | undefined;

  readonly #envPolicy: ResolvedEnvPolicy | undefined;

  readonly #envSourcePaths: ReadonlySet<string>;

  readonly #denyRead: readonly string[];

  private constructor(options: {
    root: string;
    mode: "live" | "shadow";
    mounts: readonly MountBinding[];
    shadowRoot?: string;
    emit?: EmitEvent;
    envPolicy?: ResolvedEnvPolicy;
    denyRead: readonly string[];
  }) {
    this.root = options.root;
    this.mode = options.mode;
    this.#mounts = options.mounts;
    this.#shadowRoot = options.shadowRoot;
    this.#emit = options.emit;
    this.#envPolicy = options.envPolicy;
    this.#denyRead = options.denyRead;
    this.#envSourcePaths = new Set(
      options.envPolicy?.sources
        .filter((source): source is Extract<EnvSource, { type: "file" }> => source.type === "file")
        .map((source) => sourceLogicalPath(options.root, source))
        .filter((path): path is string => path !== undefined) ?? [],
    );
  }

  public static async create(
    options: WorkspaceOptions,
    emit?: EmitEvent,
    policy?: { env?: EnvPolicy },
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
    const envPolicy =
      policy?.env === undefined ? undefined : await resolveEnvPolicy(activeRoot, policy.env);

    return new LocalWorkspaceController({
      root: activeRoot,
      mode,
      mounts,
      shadowRoot,
      emit,
      envPolicy,
      denyRead: options.denyRead ?? [],
    });
  }

  public async read(path: string): Promise<Uint8Array> {
    try {
      const target = await this.#resolveTarget(path);
      const envContent = await this.#tryReadEnvSource(target);
      if (envContent !== undefined) {
        const content = Buffer.from(envContent, "utf8");
        await this.#emitEvent({
          scope: "workspace",
          action: "read",
          outcome: "success",
          target: target.logicalPath,
          detail: `${content.byteLength} bytes`,
        });
        return content;
      }

      await this.#assertReadable(target.logicalPath);
      const content = await readFile(target.physicalPath);
      await this.#emitEvent({
        scope: "workspace",
        action: "read",
        outcome: "success",
        target: target.logicalPath,
        detail: `${content.byteLength} bytes`,
      });
      return content;
    } catch (error) {
      if (!isWorkspaceReadDeniedError(error)) {
        await this.#emitFailure("read", path, error);
      }
      throw error;
    }
  }

  public async readText(path: string): Promise<string> {
    const content = await this.read(path);
    return Buffer.from(content).toString("utf8");
  }

  public async write(path: string, content: string | Uint8Array): Promise<void> {
    try {
      const target = await this.#resolveTarget(path, { requireWritable: true });
      await mkdir(dirname(target.physicalPath), { recursive: true });
      await writeFile(target.physicalPath, content);
      await this.#emitEvent({
        scope: "workspace",
        action: "write",
        outcome: "success",
        target: target.logicalPath,
      });
    } catch (error) {
      if (!isWorkspaceWriteDeniedError(error)) {
        await this.#emitFailure("write", path, error);
      }
      throw error;
    }
  }

  public async list(path: string = "."): Promise<readonly WorkspaceEntry[]> {
    try {
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
        result.push(
          toWorkspaceEntry(entryKindFromDirent(entry), childStat.size, childLogicalPath),
        );
      }

      await this.#emitEvent({
        scope: "workspace",
        action: "list",
        outcome: "success",
        target: target.logicalPath,
        detail: `${result.length} entries`,
      });

      return result;
    } catch (error) {
      await this.#emitFailure("list", path, error);
      throw error;
    }
  }

  public async stat(path: string): Promise<WorkspaceEntry> {
    try {
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
    } catch (error) {
      await this.#emitFailure("stat", path, error);
      throw error;
    }
  }

  public async glob(pattern: string | readonly string[]): Promise<readonly string[]> {
    try {
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
    } catch (error) {
      await this.#emitFailure("glob", undefined, error);
      throw error;
    }
  }

  public async grep(
    query: string,
    options?: {
      include?: string | readonly string[];
      caseSensitive?: boolean;
      maxResults?: number;
    },
  ): Promise<readonly WorkspaceSearchResult[]> {
    try {
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

        let content: string;
        try {
          content = await this.readText(path);
        } catch (error) {
          if (isWorkspaceReadDeniedError(error)) {
            continue;
          }

          throw error;
        }
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
    } catch (error) {
      await this.#emitFailure("grep", undefined, error);
      throw error;
    }
  }

  public async remove(path: string): Promise<void> {
    try {
      const target = await this.#resolveTarget(path, { requireWritable: true });
      await rm(target.physicalPath, { recursive: true, force: true });
      await this.#emitEvent({
        scope: "workspace",
        action: "remove",
        outcome: "success",
        target: target.logicalPath,
      });
    } catch (error) {
      if (!isWorkspaceWriteDeniedError(error)) {
        await this.#emitFailure("remove", path, error);
      }
      throw error;
    }
  }

  public async resolvePath(path: string): Promise<string> {
    try {
      const target = await this.#resolveTarget(path);
      return target.physicalPath;
    } catch (error) {
      await this.#emitFailure("resolve-path", path, error);
      throw error;
    }
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
      throw new WorkspaceWriteDeniedError(`Path is not writable: ${path}`);
    }

    const relativeLogicalPath =
      mount.mountPath === "/"
        ? stripLeadingSlash(logicalPath)
        : stripLeadingSlash(normalizedForMatch.slice(mount.mountPath.length));
    const unresolvedPhysicalPath = resolve(mount.sourcePath, relativeLogicalPath);
    const canonicalRoot = await canonicalizeExistingPath(mount.sourcePath);
    const canonicalTarget = await canonicalizeForContainment(unresolvedPhysicalPath);
    if (!isWithinRoot(canonicalTarget, canonicalRoot)) {
      throw new Error(`Path escapes workspace root: ${path}`);
    }

    return {
      logicalPath,
      physicalPath: unresolvedPhysicalPath,
    };
  }

  async #tryReadEnvSource(target: ResolvedTarget): Promise<string | undefined> {
    if (!this.#envSourcePaths.has(target.logicalPath) || this.#envPolicy === undefined) {
      return undefined;
    }

    const content = await readFile(target.physicalPath, "utf8");
    const filtered = filterEnvValues(parseEnvFile(content), this.#envPolicy);
    return serializeEnvFile(filtered);
  }

  async #assertReadable(logicalPath: string): Promise<void> {
    const isEnvLike = logicalPath
      .split("/")
      .some((segment) => segment === ".env" || segment.startsWith(".env."));
    const isDenied = this.#denyRead.some((pattern) => matchesGlob(logicalPath, pattern));
    if (isEnvLike || isDenied) {
      await this.#emitEvent({
        scope: "workspace",
        action: "read-denied",
        outcome: "denied",
        target: logicalPath,
      });
      throw new WorkspaceReadDeniedError(`Path is not readable: ${logicalPath}`);
    }
  }

  async #emitEvent(event: Omit<ObservabilityEvent, "timestamp">): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    await this.#emit(event);
  }

  async #emitFailure(action: string, target: string | undefined, error: unknown): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    await this.#emit({
      scope: "workspace",
      action,
      outcome: "error",
      target,
      detail,
    });
  }
}
