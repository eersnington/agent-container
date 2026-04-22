import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type {
  EnvClassification,
  ExecController,
  ExecRunOptions,
  ExecShellOptions,
  ObservabilityEvent,
  ObservabilityOutcome,
  ObservabilityScope,
  ResolvedEnv,
  WorkspaceController,
} from "@agent-container/types";

type EmitEvent = (event: Omit<ObservabilityEvent, "timestamp">) => Promise<void>;

interface SessionCapabilityContext {
  workspace?: WorkspaceController;
  env?: ResolvedEnv;
  exec?: ExecController;
}

interface RouteResult {
  status: number;
  body: unknown;
}

interface WorkspaceGrepRequestOptions {
  include?: string | readonly string[];
  caseSensitive?: boolean;
  maxResults?: number;
}

interface BridgeExecSharedOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envKeys?: readonly string[];
  includeSecrets?: boolean;
}

class BridgeBadRequestError extends Error {}

class BridgeCapabilityUnavailableError extends Error {}

const maxTimerDelayMs = 2_147_483_647;

function parseEnvClassification(value: unknown, field: string): EnvClassification {
  if (value === "public" || value === "secret") {
    return value;
  }

  throw new BridgeBadRequestError(`Expected ${field} to be public or secret.`);
}

function parseObservabilityScope(value: unknown): ObservabilityScope {
  if (
    value === "container" ||
    value === "workspace" ||
    value === "exec" ||
    value === "env" ||
    value === "net"
  ) {
    return value;
  }

  throw new BridgeBadRequestError(
    "Expected event.scope to be one of container, workspace, exec, env, or net.",
  );
}

function parseObservabilityOutcome(value: unknown): ObservabilityOutcome {
  if (value === "success" || value === "error" || value === "denied") {
    return value;
  }

  throw new BridgeBadRequestError("Expected event.outcome to be success, error, or denied.");
}

function parseWorkspacePathRequest(
  body: unknown,
  route: string,
): {
  path: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError(`${route} expects a JSON object.`);
  }

  if (!("path" in body) || typeof body.path !== "string") {
    throw new BridgeBadRequestError(`${route} expects path to be a string.`);
  }

  if (body.path.includes("\0")) {
    throw new BridgeBadRequestError(`${route} does not allow NUL bytes in path.`);
  }

  return { path: body.path };
}

function parseWorkspaceListRequest(
  body: unknown,
): {
  path?: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/workspace/list expects a JSON object.");
  }

  if (!("path" in body) || body.path === undefined) {
    return {};
  }

  if (typeof body.path !== "string") {
    throw new BridgeBadRequestError("/workspace/list expects path to be a string when provided.");
  }

  if (body.path.includes("\0")) {
    throw new BridgeBadRequestError("/workspace/list does not allow NUL bytes in path.");
  }

  return { path: body.path };
}

function parseWorkspaceWriteTextRequest(
  body: unknown,
): {
  path: string;
  text: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/workspace/write-text expects a JSON object.");
  }

  if (!("path" in body) || typeof body.path !== "string") {
    throw new BridgeBadRequestError("/workspace/write-text expects path to be a string.");
  }

  if (body.path.includes("\0")) {
    throw new BridgeBadRequestError("/workspace/write-text does not allow NUL bytes in path.");
  }

  if (!("text" in body) || typeof body.text !== "string") {
    throw new BridgeBadRequestError("/workspace/write-text expects text to be a string.");
  }

  return {
    path: body.path,
    text: body.text,
  };
}

function parseWorkspaceGlobRequest(
  body: unknown,
): {
  pattern: string | readonly string[];
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/workspace/glob expects a JSON object.");
  }

  if (!("pattern" in body)) {
    throw new BridgeBadRequestError("/workspace/glob expects pattern to be present.");
  }

  if (typeof body.pattern === "string") {
    return { pattern: body.pattern };
  }

  if (!Array.isArray(body.pattern)) {
    throw new BridgeBadRequestError("/workspace/glob expects pattern to be a string or string array.");
  }

  const pattern: string[] = [];
  for (const entry of body.pattern) {
    if (typeof entry !== "string") {
      throw new BridgeBadRequestError(
        "/workspace/glob expects every pattern array entry to be a string.",
      );
    }

    pattern.push(entry);
  }

  return { pattern };
}

function parseWorkspaceGrepOptions(value: unknown): WorkspaceGrepRequestOptions {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeBadRequestError("/workspace/grep expects options to be an object when provided.");
  }

  const parsed: WorkspaceGrepRequestOptions = {};

  if ("include" in value && value.include !== undefined) {
    if (typeof value.include === "string") {
      parsed.include = value.include;
    } else if (Array.isArray(value.include)) {
      const include: string[] = [];
      for (const entry of value.include) {
        if (typeof entry !== "string") {
          throw new BridgeBadRequestError(
            "/workspace/grep expects every options.include entry to be a string.",
          );
        }

        include.push(entry);
      }

      parsed.include = include;
    } else {
      throw new BridgeBadRequestError(
        "/workspace/grep expects options.include to be a string or string array.",
      );
    }
  }

  if ("caseSensitive" in value && value.caseSensitive !== undefined) {
    if (typeof value.caseSensitive !== "boolean") {
      throw new BridgeBadRequestError(
        "/workspace/grep expects options.caseSensitive to be a boolean when provided.",
      );
    }

    parsed.caseSensitive = value.caseSensitive;
  }

  if ("maxResults" in value && value.maxResults !== undefined) {
    if (
      typeof value.maxResults !== "number" ||
      !Number.isFinite(value.maxResults) ||
      !Number.isInteger(value.maxResults) ||
      value.maxResults < 0
    ) {
      throw new BridgeBadRequestError(
        "/workspace/grep expects options.maxResults to be a non-negative integer when provided.",
      );
    }

    parsed.maxResults = value.maxResults;
  }

  return parsed;
}

function parseWorkspaceGrepRequest(
  body: unknown,
): {
  query: string;
  options: WorkspaceGrepRequestOptions;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/workspace/grep expects a JSON object.");
  }

  if (!("query" in body) || typeof body.query !== "string") {
    throw new BridgeBadRequestError("/workspace/grep expects query to be a string.");
  }

  return {
    query: body.query,
    options: parseWorkspaceGrepOptions("options" in body ? body.options : undefined),
  };
}

function parseExecSharedOptions(
  route: "/exec/run" | "/exec/shell",
  value: unknown,
): BridgeExecSharedOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeBadRequestError(`${route} expects options to be a JSON object.`);
  }

  const parsed: BridgeExecSharedOptions = {};

  if ("cwd" in value && value.cwd !== undefined) {
    if (typeof value.cwd !== "string") {
      throw new BridgeBadRequestError(`${route} expects options.cwd to be a string when provided.`);
    }

    if (value.cwd.includes("\0")) {
      throw new BridgeBadRequestError(`${route} does not allow NUL bytes in options.cwd.`);
    }

    parsed.cwd = value.cwd;
  }

  if ("stdin" in value && value.stdin !== undefined) {
    if (typeof value.stdin !== "string") {
      throw new BridgeBadRequestError(`${route} expects options.stdin to be a string when provided.`);
    }

    parsed.stdin = value.stdin;
  }

  if ("timeoutMs" in value && value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs !== "number" ||
      !Number.isFinite(value.timeoutMs) ||
      !Number.isInteger(value.timeoutMs) ||
      value.timeoutMs < 0 ||
      value.timeoutMs > maxTimerDelayMs
    ) {
      throw new BridgeBadRequestError(
        `${route} expects options.timeoutMs to be an integer between 0 and ${maxTimerDelayMs} when provided.`,
      );
    }

    parsed.timeoutMs = value.timeoutMs;
  }

  if ("env" in value && value.env !== undefined) {
    if (typeof value.env !== "object" || value.env === null || Array.isArray(value.env)) {
      throw new BridgeBadRequestError(`${route} expects options.env to be an object when provided.`);
    }

    const env: Record<string, string> = {};
    for (const [name, entryValue] of Object.entries(value.env)) {
      if (name === "PATH") {
        throw new BridgeBadRequestError(`${route} does not allow overriding options.env.PATH.`);
      }

      if (typeof entryValue !== "string") {
        throw new BridgeBadRequestError(`${route} expects options.env.${name} to be a string.`);
      }

      env[name] = entryValue;
    }

    parsed.env = env;
  }

  if ("envKeys" in value && value.envKeys !== undefined) {
    if (!Array.isArray(value.envKeys)) {
      throw new BridgeBadRequestError(
        `${route} expects options.envKeys to be a string array when provided.`,
      );
    }

    const envKeys: string[] = [];
    for (const entry of value.envKeys) {
      if (typeof entry !== "string") {
        throw new BridgeBadRequestError(
          `${route} expects every options.envKeys entry to be a string.`,
        );
      }

      if (entry === "PATH") {
        throw new BridgeBadRequestError(`${route} does not allow options.envKeys to include PATH.`);
      }

      envKeys.push(entry);
    }

    parsed.envKeys = envKeys;
  }

  if ("includeSecrets" in value && value.includeSecrets !== undefined) {
    if (typeof value.includeSecrets !== "boolean") {
      throw new BridgeBadRequestError(
        `${route} expects options.includeSecrets to be a boolean when provided.`,
      );
    }

    parsed.includeSecrets = value.includeSecrets;
  }

  return parsed;
}

function parseExecRunRequest(body: unknown): ExecRunOptions {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/exec/run expects a JSON object.");
  }

  if (!("options" in body)) {
    throw new BridgeBadRequestError("/exec/run expects options to be present.");
  }

  const shared = parseExecSharedOptions("/exec/run", body.options);
  if (
    typeof body.options !== "object" ||
    body.options === null ||
    Array.isArray(body.options) ||
    !("command" in body.options) ||
    typeof body.options.command !== "string"
  ) {
    throw new BridgeBadRequestError("/exec/run expects options.command to be a string.");
  }

  if (body.options.command.includes("\0")) {
    throw new BridgeBadRequestError("/exec/run does not allow NUL bytes in options.command.");
  }

  if (body.options.command === "") {
    throw new BridgeBadRequestError("/exec/run does not allow an empty options.command.");
  }

  let args: readonly string[] | undefined;
  if ("args" in body.options && body.options.args !== undefined) {
    if (!Array.isArray(body.options.args)) {
      throw new BridgeBadRequestError(
        "/exec/run expects options.args to be a string array when provided.",
      );
    }

    const parsedArgs: string[] = [];
    for (const entry of body.options.args) {
      if (typeof entry !== "string") {
        throw new BridgeBadRequestError(
          "/exec/run expects every options.args entry to be a string.",
        );
      }

      if (entry.includes("\0")) {
        throw new BridgeBadRequestError(
          "/exec/run does not allow NUL bytes in options.args entries.",
        );
      }

      parsedArgs.push(entry);
    }

    args = parsedArgs;
  }

  return {
    command: body.options.command,
    args,
    ...shared,
  };
}

function parseExecShellRequest(body: unknown): ExecShellOptions {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/exec/shell expects a JSON object.");
  }

  if (!("options" in body)) {
    throw new BridgeBadRequestError("/exec/shell expects options to be present.");
  }

  const shared = parseExecSharedOptions("/exec/shell", body.options);
  if (
    typeof body.options !== "object" ||
    body.options === null ||
    Array.isArray(body.options) ||
    !("script" in body.options) ||
    typeof body.options.script !== "string"
  ) {
    throw new BridgeBadRequestError("/exec/shell expects options.script to be a string.");
  }

  if (body.options.script.includes("\0")) {
    throw new BridgeBadRequestError("/exec/shell does not allow NUL bytes in options.script.");
  }

  return {
    script: body.options.script,
    ...shared,
  };
}

function parseEnvKeysRequest(
  body: unknown,
): {
  classification: EnvClassification;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/env/keys expects a JSON object.");
  }

  if (!("classification" in body)) {
    throw new BridgeBadRequestError("/env/keys expects classification to be present.");
  }

  return {
    classification: parseEnvClassification(body.classification, "classification"),
  };
}

function parseEnvGetRequest(
  body: unknown,
): {
  name: string;
  classification: EnvClassification;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/env/get expects a JSON object.");
  }

  if (!("name" in body) || typeof body.name !== "string") {
    throw new BridgeBadRequestError("/env/get expects name to be a string.");
  }

  if (!("classification" in body)) {
    throw new BridgeBadRequestError("/env/get expects classification to be present.");
  }

  return {
    name: body.name,
    classification: parseEnvClassification(body.classification, "classification"),
  };
}

function parseObserveEmitRequest(
  body: unknown,
): {
  event: Omit<ObservabilityEvent, "timestamp">;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError("/observe/emit expects a JSON object.");
  }

  if (
    !("event" in body) ||
    typeof body.event !== "object" ||
    body.event === null ||
    Array.isArray(body.event)
  ) {
    throw new BridgeBadRequestError("/observe/emit expects event to be a JSON object.");
  }

  if (!("action" in body.event) || typeof body.event.action !== "string") {
    throw new BridgeBadRequestError("/observe/emit expects event.action to be a string.");
  }

  if (!("scope" in body.event)) {
    throw new BridgeBadRequestError("/observe/emit expects event.scope to be present.");
  }

  if (!("outcome" in body.event)) {
    throw new BridgeBadRequestError("/observe/emit expects event.outcome to be present.");
  }

  const event: Omit<ObservabilityEvent, "timestamp"> = {
    scope: parseObservabilityScope(body.event.scope),
    action: body.event.action,
    outcome: parseObservabilityOutcome(body.event.outcome),
  };

  if ("target" in body.event && body.event.target !== undefined) {
    if (typeof body.event.target !== "string") {
      throw new BridgeBadRequestError(
        "/observe/emit expects event.target to be a string when provided.",
      );
    }

    event.target = body.event.target;
  }

  if ("detail" in body.event && body.event.detail !== undefined) {
    if (typeof body.event.detail !== "string") {
      throw new BridgeBadRequestError(
        "/observe/emit expects event.detail to be a string when provided.",
      );
    }

    event.detail = body.event.detail;
  }

  return { event };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeBadRequestError("Expected request body to be valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

export class LocalCapabilityBridgeServer {
  public readonly token: string;

  readonly #context: SessionCapabilityContext;

  readonly #emit: EmitEvent | undefined;

  readonly #server = createServer(this.#handleRequest.bind(this));

  #port = 0;

  private constructor(context: SessionCapabilityContext, emit?: EmitEvent) {
    this.token = randomUUID();
    this.#context = context;
    this.#emit = emit;
  }

  public static async create(
    context: SessionCapabilityContext = {},
    emit?: EmitEvent,
  ): Promise<LocalCapabilityBridgeServer> {
    const bridge = new LocalCapabilityBridgeServer(context, emit);
    await bridge.start();
    return bridge;
  }

  public get port(): number {
    return this.#port;
  }

  public async stop(): Promise<void> {
    if (this.#port === 0) {
      return;
    }

    await new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        this.#port = 0;
        resolvePromise();
      });
    });
  }

  public async start(): Promise<void> {
    if (this.#port !== 0) {
      return;
    }

    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => {
        this.#server.off("error", onError);
        reject(error);
      };

      this.#server.on("error", onError);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", onError);
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Capability bridge failed to bind a local port."));
          return;
        }

        this.#port = address.port;
        resolvePromise();
      });
    });
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Only POST requests are supported." });
        return;
      }

      const token = request.headers["x-agent-container-bridge-token"];
      if (token !== this.token) {
        sendJson(response, 401, { error: "Invalid bridge token." });
        return;
      }

      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readJsonBody(request);
      const result = await this.#route(url.pathname, body);
      sendJson(response, result.status, result.body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof BridgeBadRequestError
          ? 400
          : error instanceof BridgeCapabilityUnavailableError
            ? 403
            : 500;
      sendJson(response, status, { error: detail });
    }
  }

  async #route(pathname: string, body: unknown): Promise<RouteResult> {
    switch (pathname) {
      case "/workspace/read-text":
        return this.#workspaceReadText(body);
      case "/workspace/write-text":
        return this.#workspaceWriteText(body);
      case "/workspace/list":
        return this.#workspaceList(body);
      case "/workspace/stat":
        return this.#workspaceStat(body);
      case "/workspace/glob":
        return this.#workspaceGlob(body);
      case "/workspace/grep":
        return this.#workspaceGrep(body);
      case "/workspace/remove":
        return this.#workspaceRemove(body);
      case "/exec/run":
        return this.#execRun(body);
      case "/exec/shell":
        return this.#execShell(body);
      case "/env/keys":
        return this.#envKeys(body);
      case "/env/get":
        return this.#envGet(body);
      case "/observe/emit":
        return this.#observeEmit(body);
      default:
        return { status: 404, body: { error: `Unknown capability path: ${pathname}` } };
    }
  }

  async #workspaceReadText(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { path } = parseWorkspacePathRequest(body, "/workspace/read-text");
    const text = await workspace.readText(path);
    return { status: 200, body: { result: text } };
  }

  async #workspaceWriteText(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { path, text } = parseWorkspaceWriteTextRequest(body);
    await workspace.write(path, text);
    return { status: 200, body: { result: null } };
  }

  async #workspaceList(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { path } = parseWorkspaceListRequest(body);
    const result = await workspace.list(path);
    return { status: 200, body: { result } };
  }

  async #workspaceStat(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { path } = parseWorkspacePathRequest(body, "/workspace/stat");
    const result = await workspace.stat(path);
    return { status: 200, body: { result } };
  }

  async #workspaceGlob(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { pattern } = parseWorkspaceGlobRequest(body);
    const result = await workspace.glob(pattern);
    return { status: 200, body: { result } };
  }

  async #workspaceGrep(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { query, options } = parseWorkspaceGrepRequest(body);
    const result = await workspace.grep(query, options);
    return { status: 200, body: { result } };
  }

  async #workspaceRemove(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { path } = parseWorkspacePathRequest(body, "/workspace/remove");
    await workspace.remove(path);
    return { status: 200, body: { result: null } };
  }

  async #execRun(body: unknown): Promise<RouteResult> {
    const exec = this.#requireExec();
    const result = await exec.run(parseExecRunRequest(body));
    return { status: 200, body: { result } };
  }

  async #execShell(body: unknown): Promise<RouteResult> {
    const exec = this.#requireExec();
    const result = await exec.shell(parseExecShellRequest(body));
    return { status: 200, body: { result } };
  }

  async #envKeys(body: unknown): Promise<RouteResult> {
    const env = this.#requireEnv();
    const { classification } = parseEnvKeysRequest(body);
    const snapshot = env.snapshot();
    const result = classification === "secret" ? snapshot.secretKeys : snapshot.publicKeys;
    await this.#emitEvent({
      scope: "env",
      action: `${classification}.keys`,
      outcome: "success",
      detail: `${result.length} keys`,
    });
    return { status: 200, body: { result } };
  }

  async #envGet(body: unknown): Promise<RouteResult> {
    const env = this.#requireEnv();
    const { name, classification } = parseEnvGetRequest(body);
    const actualClassification = env.getClassification(name);
    if (actualClassification === undefined || actualClassification !== classification) {
      return { status: 200, body: { result: null } };
    }

    await this.#emitEvent({
      scope: "env",
      action: `${classification}.get`,
      outcome: "success",
      target: name,
    });
    return { status: 200, body: { result: env.get(name) ?? null } };
  }

  async #observeEmit(body: unknown): Promise<RouteResult> {
    const { event } = parseObserveEmitRequest(body);
    await this.#emitEvent(event);
    return { status: 200, body: { result: null } };
  }

  #requireWorkspace(): WorkspaceController {
    if (this.#context.workspace === undefined) {
      throw new BridgeCapabilityUnavailableError(
        "Workspace capability is not configured for this session.",
      );
    }

    return this.#context.workspace;
  }

  #requireEnv(): ResolvedEnv {
    if (this.#context.env === undefined) {
      throw new BridgeCapabilityUnavailableError("Env capability is not configured for this session.");
    }

    return this.#context.env;
  }

  #requireExec(): ExecController {
    if (this.#context.exec === undefined) {
      throw new BridgeCapabilityUnavailableError(
        "Exec capability is not configured for this session.",
      );
    }

    return this.#context.exec;
  }

  async #emitEvent(event: Omit<ObservabilityEvent, "timestamp">): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    await this.#emit(event);
  }
}

export type { SessionCapabilityContext };
