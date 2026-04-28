import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  BridgeBadRequestError,
  parseEnvGetRequest,
  parseEnvKeysRequest,
  parseExecRunRequest,
  parseExecShellRequest,
  parseObserveEmitRequest,
  parseWorkspaceGlobRequest,
  parseWorkspaceGrepRequest,
  parseWorkspaceListRequest,
  parseWorkspacePathRequest,
  parseWorkspaceWriteTextRequest,
} from './requests.js';

import type {
  ExecController,
  ObservabilityEvent,
  ResolvedEnv,
  WorkspaceController,
} from '@agent-container/types';

type EmitEvent = (event: Omit<ObservabilityEvent, 'timestamp'>) => Promise<void>;

interface SessionCapabilityContext {
  workspace?: WorkspaceController;
  env?: ResolvedEnv;
  exec?: ExecController;
}

interface RouteResult {
  status: number;
  body: unknown;
}

class BridgeCapabilityUnavailableError extends Error {}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeBadRequestError('Expected request body to be valid JSON.');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
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
        this.#server.off('error', onError);
        reject(error);
      };

      this.#server.on('error', onError);
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', onError);
        const address = this.#server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('Capability bridge failed to bind a local port.'));
          return;
        }

        this.#port = address.port;
        resolvePromise();
      });
    });
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Only POST requests are supported.' });
        return;
      }

      const token = request.headers['x-agent-container-bridge-token'];
      if (token !== this.token) {
        sendJson(response, 401, { error: 'Invalid bridge token.' });
        return;
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
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
      case '/workspace/read-text':
        return this.#workspaceReadText(body);
      case '/workspace/write-text':
        return this.#workspaceWriteText(body);
      case '/workspace/list':
        return this.#workspaceList(body);
      case '/workspace/stat':
        return this.#workspaceStat(body);
      case '/workspace/glob':
        return this.#workspaceGlob(body);
      case '/workspace/grep':
        return this.#workspaceGrep(body);
      case '/workspace/remove':
        return this.#workspaceRemove(body);
      case '/exec/run':
        return this.#execRun(body);
      case '/exec/shell':
        return this.#execShell(body);
      case '/env/keys':
        return this.#envKeys(body);
      case '/env/get':
        return this.#envGet(body);
      case '/observe/emit':
        return this.#observeEmit(body);
      default:
        return { status: 404, body: { error: `Unknown capability path: ${pathname}` } };
    }
  }

  async #workspaceReadText(body: unknown): Promise<RouteResult> {
    const workspace = this.#requireWorkspace();
    const { path } = parseWorkspacePathRequest(body, '/workspace/read-text');
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
    const { path } = parseWorkspacePathRequest(body, '/workspace/stat');
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
    const { path } = parseWorkspacePathRequest(body, '/workspace/remove');
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
    const result = classification === 'secret' ? snapshot.secretKeys : snapshot.publicKeys;
    await this.#emitEvent({
      scope: 'env',
      action: `${classification}.keys`,
      outcome: 'success',
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
      scope: 'env',
      action: `${classification}.get`,
      outcome: 'success',
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
        'Workspace capability is not configured for this session.',
      );
    }

    return this.#context.workspace;
  }

  #requireEnv(): ResolvedEnv {
    if (this.#context.env === undefined) {
      throw new BridgeCapabilityUnavailableError(
        'Env capability is not configured for this session.',
      );
    }

    return this.#context.env;
  }

  #requireExec(): ExecController {
    if (this.#context.exec === undefined) {
      throw new BridgeCapabilityUnavailableError(
        'Exec capability is not configured for this session.',
      );
    }

    return this.#context.exec;
  }

  async #emitEvent(event: Omit<ObservabilityEvent, 'timestamp'>): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    await this.#emit(event);
  }
}

export type { SessionCapabilityContext };
