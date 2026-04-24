import { dirname, extname, posix, relative, sep } from "node:path";

import { transform } from "esbuild";

import type {
  WorkerdRunInput,
  WorkerdRunOptions,
  WorkerdSourceLanguage,
  WorkspaceController,
} from "@agent-container/types";

export type WorkerdModuleKind = "esModule" | "json" | "text" | "wasm";

export interface PreparedWorkerdModule {
  name: string;
  fileName: string;
  kind: WorkerdModuleKind;
  content: string | Uint8Array;
}

export interface PreparedWorkerdRun {
  entryModuleName: string;
  modules: readonly PreparedWorkerdModule[];
}

interface ModuleSource {
  name: string;
  content: string | Uint8Array;
  language: WorkerdSourceLanguage | "json" | "text" | "wasm";
}

interface StaticImport {
  specifier: string;
}

const supportedStaticModuleExtensions = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".txt",
  ".wasm",
] as const;

function normalizeModuleName(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

function moduleFileName(name: string): string {
  return `modules/${name.replace(/[^A-Za-z0-9._-]/gu, "_")}`;
}

function isRelativeSpecifier(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../");
}

function languageFromName(name: string): ModuleSource["language"] {
  const extension = extname(name).toLowerCase();
  if (extension === ".ts") {
    return "ts";
  }
  if (extension === ".tsx") {
    return "tsx";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".txt") {
    return "text";
  }
  if (extension === ".wasm") {
    return "wasm";
  }
  return "js";
}

function extractStaticImports(source: string): readonly StaticImport[] {
  const imports: StaticImport[] = [];
  const staticImportPattern =
    /\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gu;
  for (const match of source.matchAll(staticImportPattern)) {
    const statement = match[0];
    if (/^\s*(?:import|export)\s+type\b/u.test(statement)) {
      continue;
    }

    const specifier = match[1];
    if (specifier !== undefined) {
      imports.push({ specifier });
    }
  }
  return imports;
}

function assertNoUnsupportedImports(source: string, moduleName: string): void {
  const dynamicImportPattern = /\bimport\s*\(\s*["'][^"']+["']\s*\)/u;
  if (dynamicImportPattern.test(source)) {
    throw new Error(`Dynamic imports are not supported in workerd module runs: ${moduleName}`);
  }

  for (const { specifier } of extractStaticImports(source)) {
    if (!isRelativeSpecifier(specifier)) {
      throw new Error(
        `Only static relative imports are supported in workerd module runs: ${specifier}`,
      );
    }
  }
}

function resolveModuleSpecifier(importerName: string, specifier: string): string {
  const importerDir = dirname(importerName).replace(/\\/gu, "/");
  return normalizeModuleName(posix.normalize(posix.join(importerDir, specifier)));
}

async function resolveWorkspaceModule(options: {
  workspace: WorkspaceController;
  importerName: string;
  specifier: string;
}): Promise<string> {
  const baseName = resolveModuleSpecifier(options.importerName, options.specifier);
  const extension = extname(baseName);
  const candidates =
    extension === ""
      ? supportedStaticModuleExtensions.map(
          (candidateExtension) => `${baseName}${candidateExtension}`,
        )
      : extension === ".js"
        ? [
            baseName,
            `${baseName.slice(0, -extension.length)}.ts`,
            `${baseName.slice(0, -extension.length)}.tsx`,
          ]
        : [baseName];

  for (const candidate of candidates) {
    try {
      const entry = await options.workspace.stat(candidate);
      if (entry.kind === "file") {
        return normalizeModuleName(candidate);
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`Could not resolve module import ${options.specifier} from ${options.importerName}`);
}

function rewriteSpecifier(source: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const importSpecifierPattern = new RegExp(
    `(\\b(?:import|export)\\s+(?:[^"'()]*?\\s+from\\s+)?)(["'])${escaped}\\2`,
    "gu",
  );
  return source.replace(
    importSpecifierPattern,
    (_match, prefix: string, quote: string) => `${prefix}${quote}${to}${quote}`,
  );
}

function relativeSpecifier(fromModuleName: string, toModuleName: string): string {
  const relativePath = posix.relative(posix.dirname(fromModuleName), toModuleName);
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

async function transformModuleSource(options: {
  module: ModuleSource;
  importRewrites: ReadonlyMap<string, string>;
}): Promise<PreparedWorkerdModule> {
  const kind: WorkerdModuleKind =
    options.module.language === "json"
      ? "json"
      : options.module.language === "text"
        ? "text"
        : options.module.language === "wasm"
          ? "wasm"
          : "esModule";

  let content = options.module.content;
  if (options.module.language === "wasm") {
    return {
      name: options.module.name,
      fileName: moduleFileName(options.module.name),
      kind,
      content,
    };
  }

  if (typeof content !== "string") {
    throw new Error(`Expected text module content for ${options.module.name}.`);
  }

  for (const [from, to] of options.importRewrites) {
    content = rewriteSpecifier(content, from, to);
  }

  if (options.module.language === "ts" || options.module.language === "tsx") {
    const result = await transform(content, {
      format: "esm",
      jsx: "transform",
      jsxFactory: "h",
      jsxFragment: "Fragment",
      loader: options.module.language,
      sourcemap: "inline",
      sourcefile: options.module.name,
      target: "es2022",
    });
    content = result.code;
  }

  return {
    name: options.module.name,
    fileName: moduleFileName(options.module.name),
    kind,
    content,
  };
}

async function createEntrySource(
  input: WorkerdRunInput,
  options: WorkerdRunOptions | undefined,
  workspace: WorkspaceController | undefined,
): Promise<ModuleSource> {
  if (typeof input === "string") {
    const language = options?.language ?? "js";
    const name = normalizeModuleName(options?.name ?? `entry.${language}`);
    return {
      name,
      content: input,
      language,
    };
  }

  if (workspace === undefined) {
    throw new Error("Path sources require a workspace capability.");
  }

  const name = normalizeModuleName(input.path);
  const physicalPath = await workspace.resolvePath(name);
  const rootRelativePath = relative(workspace.root, physicalPath);
  if (rootRelativePath.startsWith("..") || rootRelativePath.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes workspace root: ${input.path}`);
  }
  const language = languageFromName(name);

  return {
    name,
    content: language === "wasm" ? await workspace.read(name) : await workspace.readText(name),
    language,
  };
}

export async function prepareWorkerdRun(options: {
  input: WorkerdRunInput;
  options?: WorkerdRunOptions;
  workspace?: WorkspaceController;
}): Promise<PreparedWorkerdRun> {
  const entry = await createEntrySource(options.input, options.options, options.workspace);
  const modules = new Map<string, ModuleSource>();
  const importRewritesByModule = new Map<string, Map<string, string>>();
  const pending: ModuleSource[] = [entry];

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || modules.has(current.name)) {
      continue;
    }

    if (
      typeof current.content === "string" &&
      current.language !== "json" &&
      current.language !== "text"
    ) {
      assertNoUnsupportedImports(current.content, current.name);
    }

    modules.set(current.name, current);
    const rewrites = new Map<string, string>();
    importRewritesByModule.set(current.name, rewrites);

    if (
      current.language === "json" ||
      current.language === "text" ||
      current.language === "wasm"
    ) {
      continue;
    }

    if (typeof current.content !== "string") {
      continue;
    }

    for (const { specifier } of extractStaticImports(current.content)) {
      if (typeof options.input === "string") {
        throw new Error("Relative imports are only supported for workspace path sources.");
      }
      if (options.workspace === undefined) {
        throw new Error("Relative imports require a workspace capability.");
      }

      const resolvedName = await resolveWorkspaceModule({
        workspace: options.workspace,
        importerName: current.name,
        specifier,
      });
      rewrites.set(specifier, relativeSpecifier(current.name, resolvedName));
      if (!modules.has(resolvedName)) {
        const language = languageFromName(resolvedName);
        pending.push({
          name: resolvedName,
          content:
            language === "wasm"
              ? await options.workspace.read(resolvedName)
              : await options.workspace.readText(resolvedName),
          language,
        });
      }
    }
  }

  const preparedModules = await Promise.all(
    [...modules.values()].map((module) =>
      transformModuleSource({
        module,
        importRewrites: importRewritesByModule.get(module.name) ?? new Map(),
      }),
    ),
  );

  return {
    entryModuleName: entry.name,
    modules: preparedModules,
  };
}
