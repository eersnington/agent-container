import { dirname, extname, posix, relative, sep } from "node:path";

import { transform } from "esbuild";

import type {
  WorkerdRunSource,
  WorkerdSourceLanguage,
  WorkspaceController,
} from "@agent-container/types";

export type WorkerdModuleKind = "esModule" | "json" | "text";

export interface PreparedWorkerdModule {
  name: string;
  fileName: string;
  kind: WorkerdModuleKind;
  content: string;
}

export interface PreparedWorkerdRun {
  entryModuleName: string;
  modules: readonly PreparedWorkerdModule[];
}

interface ModuleSource {
  name: string;
  content: string;
  language: WorkerdSourceLanguage | "json" | "text";
}

interface StaticImport {
  specifier: string;
}

const moduleExtensions = [".ts", ".tsx", ".js", ".mjs", ".json", ".txt"] as const;

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
      ? moduleExtensions.map((candidateExtension) => `${baseName}${candidateExtension}`)
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
        : "esModule";

  let content = options.module.content;
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
  source: WorkerdRunSource,
  workspace: WorkspaceController | undefined,
): Promise<ModuleSource> {
  if (source.type === "code") {
    const name = normalizeModuleName(source.name ?? `entry.${source.language === "js" ? "js" : source.language}`);
    return {
      name,
      content: source.code,
      language: source.language,
    };
  }

  if (workspace === undefined) {
    throw new Error("Path sources require a workspace capability.");
  }

  const name = normalizeModuleName(source.path);
  const physicalPath = await workspace.resolvePath(name);
  const rootRelativePath = relative(workspace.root, physicalPath);
  if (rootRelativePath.startsWith("..") || rootRelativePath.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes workspace root: ${source.path}`);
  }

  return {
    name,
    content: await workspace.readText(name),
    language: languageFromName(name),
  };
}

export async function prepareWorkerdRun(options: {
  source: WorkerdRunSource;
  workspace?: WorkspaceController;
}): Promise<PreparedWorkerdRun> {
  const entry = await createEntrySource(options.source, options.workspace);
  const modules = new Map<string, ModuleSource>();
  const importRewritesByModule = new Map<string, Map<string, string>>();
  const pending: ModuleSource[] = [entry];

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined || modules.has(current.name)) {
      continue;
    }

    if (current.language !== "json" && current.language !== "text") {
      assertNoUnsupportedImports(current.content, current.name);
    }

    modules.set(current.name, current);
    const rewrites = new Map<string, string>();
    importRewritesByModule.set(current.name, rewrites);

    if (current.language === "json" || current.language === "text") {
      continue;
    }

    for (const { specifier } of extractStaticImports(current.content)) {
      if (options.source.type === "code") {
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
        pending.push({
          name: resolvedName,
          content: await options.workspace.readText(resolvedName),
          language: languageFromName(resolvedName),
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
