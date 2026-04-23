import { readdir, readFile } from "node:fs/promises";
import { matchesGlob, resolve } from "node:path";

import type {
  EnvClassification,
  EnvPolicy,
  EnvSource,
  ProcessEnvMode,
  ResolvedEnv,
  ResolvedEnvEntry,
  ResolvedEnvSnapshot,
} from "@agent-container/types";

const DEFAULT_SECRET_PATTERNS = ["*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD"] as const;

const DEFAULT_PUBLIC_PATTERNS = ["PUBLIC_*"] as const;

function matchesPatterns(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(value, pattern));
}

export interface ResolvedEnvPolicy {
  sources: readonly EnvSource[];
  include: readonly string[];
  exclude: readonly string[];
  publicPatterns: readonly string[];
  secretPatterns: readonly string[];
  processEnv: ProcessEnvMode;
}

async function discoverRootEnvSources(repoRoot: string): Promise<readonly EnvSource[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(repoRoot);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry === ".env" || entry.startsWith(".env."))
    .sort()
    .map((path) => ({ type: "file", path, optional: true }) satisfies EnvSource);
}

async function normalizeSources(repoRoot: string, policy: EnvPolicy): Promise<readonly EnvSource[]> {
  if (policy.sources !== undefined && policy.sources.length > 0) {
    return policy.sources;
  }

  const sources: EnvSource[] = [...(await discoverRootEnvSources(repoRoot))];
  if ((policy.processEnv ?? "none") !== "none") {
    sources.push({ type: "process" });
  }
  return sources;
}

export function shouldIncludeEnvName(
  name: string,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const included = include.length === 0 || matchesPatterns(name, include);
  if (!included) {
    return false;
  }

  return !matchesPatterns(name, exclude);
}

function classifyEnvName(
  name: string,
  options: {
    publicPatterns: readonly string[];
    secretPatterns: readonly string[];
  },
): EnvClassification {
  if (matchesPatterns(name, options.publicPatterns)) {
    return "public";
  }

  return matchesPatterns(name, options.secretPatterns) ? "secret" : "public";
}

export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const separatorIndex = withoutExport.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = withoutExport.slice(0, separatorIndex).trim();
    const rawValue = withoutExport.slice(separatorIndex + 1).trim();
    if (name === "") {
      continue;
    }

    let value = rawValue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    value = value.replace(/\\n/gu, "\n");
    values[name] = value;
  }

  return values;
}

export function serializeEnvFile(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n");
}

export function filterEnvValues(
  values: Record<string, string>,
  options: {
    include: readonly string[];
    exclude: readonly string[];
  },
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!shouldIncludeEnvName(name, options.include, options.exclude)) {
      continue;
    }

    filtered[name] = value;
  }

  return filtered;
}

async function loadFileSource(
  repoRoot: string,
  source: Extract<EnvSource, { type: "file" }>,
): Promise<Record<string, string>> {
  const filePath = resolve(repoRoot, source.path);
  try {
    const content = await readFile(filePath, "utf8");
    return parseEnvFile(content);
  } catch (error) {
    if (source.optional === true) {
      return {};
    }

    throw error;
  }
}

function loadProcessSource(
  processEnvMode: ProcessEnvMode,
  include: readonly string[],
  exclude: readonly string[],
): Record<string, string> {
  if (processEnvMode === "none") {
    return {};
  }

  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }

    if (processEnvMode === "allow-matching") {
      if (!shouldIncludeEnvName(name, include, exclude)) {
        continue;
      }
    } else if (matchesPatterns(name, exclude)) {
      continue;
    }

    values[name] = value;
  }

  return values;
}

class ResolvedEnvMap implements ResolvedEnv {
  readonly #entries: Readonly<Record<string, ResolvedEnvEntry>>;

  readonly #publicKeys: readonly string[];

  readonly #secretKeys: readonly string[];

  public constructor(entries: Record<string, ResolvedEnvEntry>) {
    const publicKeys: string[] = [];
    const secretKeys: string[] = [];

    for (const [name, entry] of Object.entries(entries)) {
      if (entry.classification === "secret") {
        secretKeys.push(name);
      } else {
        publicKeys.push(name);
      }
    }

    this.#entries = Object.freeze({ ...entries });
    this.#publicKeys = Object.freeze(publicKeys.sort());
    this.#secretKeys = Object.freeze(secretKeys.sort());
  }

  public snapshot(): ResolvedEnvSnapshot {
    return {
      entries: this.#entries,
      publicKeys: this.#publicKeys,
      secretKeys: this.#secretKeys,
    };
  }

  public get(name: string): string | undefined {
    return this.#entries[name]?.value;
  }

  public getClassification(name: string): EnvClassification | undefined {
    return this.#entries[name]?.classification;
  }

  public toObject(options?: { includeSecrets?: boolean }): Record<string, string> {
    const includeSecrets = options?.includeSecrets ?? false;
    const values: Record<string, string> = {};

    for (const [name, entry] of Object.entries(this.#entries)) {
      if (!includeSecrets && entry.classification === "secret") {
        continue;
      }

      values[name] = entry.value;
    }

    return values;
  }
}

export async function resolveEnvPolicy(
  repoRoot: string,
  policy: EnvPolicy,
): Promise<ResolvedEnvPolicy> {
  const include = policy.include ?? [];
  const exclude = policy.exclude ?? [];
  const publicPatterns = policy.publicPatterns ?? DEFAULT_PUBLIC_PATTERNS;
  const secretPatterns = policy.secretPatterns ?? DEFAULT_SECRET_PATTERNS;
  const processEnvMode = policy.processEnv ?? "none";

  return {
    sources: await normalizeSources(repoRoot, policy),
    include,
    exclude,
    publicPatterns,
    secretPatterns,
    processEnv: processEnvMode,
  };
}

export async function resolveEnv(repoRoot: string, policy?: EnvPolicy): Promise<ResolvedEnv> {
  if (policy === undefined) {
    return new ResolvedEnvMap({});
  }

  const envPolicy = await resolveEnvPolicy(repoRoot, policy);

  const mergedEntries = new Map<string, { value: string; source: string }>();
  for (const source of envPolicy.sources) {
    let values: Record<string, string>;
    let sourceName: string;

    if (source.type === "file") {
      values = await loadFileSource(repoRoot, source);
      sourceName = `file:${source.path}`;
    } else if (source.type === "process") {
      values = loadProcessSource(envPolicy.processEnv, envPolicy.include, envPolicy.exclude);
      sourceName = "process";
    } else {
      values = source.values;
      sourceName = "inline";
    }

    for (const [name, value] of Object.entries(values)) {
      mergedEntries.set(name, { value, source: sourceName });
    }
  }

  const finalEntries: Record<string, ResolvedEnvEntry> = {};
  for (const [name, entry] of mergedEntries) {
    if (!shouldIncludeEnvName(name, envPolicy.include, envPolicy.exclude)) {
      continue;
    }

    finalEntries[name] = {
      value: entry.value,
      source: entry.source,
      classification: classifyEnvName(name, {
        publicPatterns: envPolicy.publicPatterns,
        secretPatterns: envPolicy.secretPatterns,
      }),
    };
  }

  return new ResolvedEnvMap(finalEntries);
}
