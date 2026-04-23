import { readFile } from "node:fs/promises";
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

const DEFAULT_ENV_SOURCES = [
  { type: "file", path: ".env", optional: true },
  { type: "file", path: ".env.local", optional: true },
] as const;

const DEFAULT_SECRET_PATTERNS = ["*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD"] as const;

const DEFAULT_PUBLIC_PATTERNS = ["PUBLIC_*"] as const;

function matchesPatterns(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(value, pattern));
}

function normalizeSources(policy: EnvPolicy): readonly EnvSource[] {
  if (policy.sources !== undefined && policy.sources.length > 0) {
    return policy.sources;
  }

  const sources: EnvSource[] = [...DEFAULT_ENV_SOURCES];
  if ((policy.processEnv ?? "none") !== "none") {
    sources.push({ type: "process" });
  }
  return sources;
}

function shouldIncludeName(
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

function parseEnvFile(content: string): Record<string, string> {
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
      if (!shouldIncludeName(name, include, exclude)) {
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

export async function resolveEnv(repoRoot: string, policy?: EnvPolicy): Promise<ResolvedEnv> {
  if (policy === undefined) {
    return new ResolvedEnvMap({});
  }

  const include = policy.include ?? [];
  const exclude = policy.exclude ?? [];
  const publicPatterns = policy.publicPatterns ?? DEFAULT_PUBLIC_PATTERNS;
  const secretPatterns = policy.secretPatterns ?? DEFAULT_SECRET_PATTERNS;
  const processEnvMode = policy.processEnv ?? "none";

  const mergedEntries = new Map<string, { value: string; source: string }>();
  for (const source of normalizeSources(policy)) {
    let values: Record<string, string>;
    let sourceName: string;

    if (source.type === "file") {
      values = await loadFileSource(repoRoot, source);
      sourceName = `file:${source.path}`;
    } else if (source.type === "process") {
      values = loadProcessSource(processEnvMode, include, exclude);
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
    if (!shouldIncludeName(name, include, exclude)) {
      continue;
    }

    finalEntries[name] = {
      value: entry.value,
      source: entry.source,
      classification: classifyEnvName(name, { publicPatterns, secretPatterns }),
    };
  }

  return new ResolvedEnvMap(finalEntries);
}
