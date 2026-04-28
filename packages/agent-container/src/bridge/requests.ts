import type {
  EnvClassification,
  ExecRunOptions,
  ExecShellOptions,
  ObservabilityEvent,
  ObservabilityOutcome,
  ObservabilityScope,
} from '@agent-container/types';

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

export class BridgeBadRequestError extends Error {}

const maxTimerDelayMs = 2_147_483_647;

function parseEnvClassification(value: unknown, field: string): EnvClassification {
  if (value === 'public' || value === 'secret') {
    return value;
  }

  throw new BridgeBadRequestError(`Expected ${field} to be public or secret.`);
}

function parseObservabilityScope(value: unknown): ObservabilityScope {
  if (
    value === 'container' ||
    value === 'workspace' ||
    value === 'exec' ||
    value === 'env' ||
    value === 'net'
  ) {
    return value;
  }

  throw new BridgeBadRequestError(
    'Expected event.scope to be one of container, workspace, exec, env, or net.',
  );
}

function parseObservabilityOutcome(value: unknown): ObservabilityOutcome {
  if (value === 'success' || value === 'error' || value === 'denied') {
    return value;
  }

  throw new BridgeBadRequestError('Expected event.outcome to be success, error, or denied.');
}

export function parseWorkspacePathRequest(
  body: unknown,
  route: string,
): {
  path: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError(`${route} expects a JSON object.`);
  }

  if (!('path' in body) || typeof body.path !== 'string') {
    throw new BridgeBadRequestError(`${route} expects path to be a string.`);
  }

  if (body.path.includes('\0')) {
    throw new BridgeBadRequestError(`${route} does not allow NUL bytes in path.`);
  }

  return { path: body.path };
}

export function parseWorkspaceListRequest(body: unknown): {
  path?: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/workspace/list expects a JSON object.');
  }

  if (!('path' in body) || body.path === undefined) {
    return {};
  }

  if (typeof body.path !== 'string') {
    throw new BridgeBadRequestError('/workspace/list expects path to be a string when provided.');
  }

  if (body.path.includes('\0')) {
    throw new BridgeBadRequestError('/workspace/list does not allow NUL bytes in path.');
  }

  return { path: body.path };
}

export function parseWorkspaceWriteTextRequest(body: unknown): {
  path: string;
  text: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/workspace/write-text expects a JSON object.');
  }

  if (!('path' in body) || typeof body.path !== 'string') {
    throw new BridgeBadRequestError('/workspace/write-text expects path to be a string.');
  }

  if (body.path.includes('\0')) {
    throw new BridgeBadRequestError('/workspace/write-text does not allow NUL bytes in path.');
  }

  if (!('text' in body) || typeof body.text !== 'string') {
    throw new BridgeBadRequestError('/workspace/write-text expects text to be a string.');
  }

  return {
    path: body.path,
    text: body.text,
  };
}

export function parseWorkspaceGlobRequest(body: unknown): {
  pattern: string | readonly string[];
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/workspace/glob expects a JSON object.');
  }

  if (!('pattern' in body)) {
    throw new BridgeBadRequestError('/workspace/glob expects pattern to be present.');
  }

  if (typeof body.pattern === 'string') {
    return { pattern: body.pattern };
  }

  if (!Array.isArray(body.pattern)) {
    throw new BridgeBadRequestError(
      '/workspace/glob expects pattern to be a string or string array.',
    );
  }

  const pattern: string[] = [];
  for (const entry of body.pattern) {
    if (typeof entry !== 'string') {
      throw new BridgeBadRequestError(
        '/workspace/glob expects every pattern array entry to be a string.',
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

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BridgeBadRequestError(
      '/workspace/grep expects options to be an object when provided.',
    );
  }

  const parsed: WorkspaceGrepRequestOptions = {};

  if ('include' in value && value.include !== undefined) {
    if (typeof value.include === 'string') {
      parsed.include = value.include;
    } else if (Array.isArray(value.include)) {
      const include: string[] = [];
      for (const entry of value.include) {
        if (typeof entry !== 'string') {
          throw new BridgeBadRequestError(
            '/workspace/grep expects every options.include entry to be a string.',
          );
        }

        include.push(entry);
      }

      parsed.include = include;
    } else {
      throw new BridgeBadRequestError(
        '/workspace/grep expects options.include to be a string or string array.',
      );
    }
  }

  if ('caseSensitive' in value && value.caseSensitive !== undefined) {
    if (typeof value.caseSensitive !== 'boolean') {
      throw new BridgeBadRequestError(
        '/workspace/grep expects options.caseSensitive to be a boolean when provided.',
      );
    }

    parsed.caseSensitive = value.caseSensitive;
  }

  if ('maxResults' in value && value.maxResults !== undefined) {
    if (
      typeof value.maxResults !== 'number' ||
      !Number.isFinite(value.maxResults) ||
      !Number.isInteger(value.maxResults) ||
      value.maxResults < 0
    ) {
      throw new BridgeBadRequestError(
        '/workspace/grep expects options.maxResults to be a non-negative integer when provided.',
      );
    }

    parsed.maxResults = value.maxResults;
  }

  return parsed;
}

export function parseWorkspaceGrepRequest(body: unknown): {
  query: string;
  options: WorkspaceGrepRequestOptions;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/workspace/grep expects a JSON object.');
  }

  if (!('query' in body) || typeof body.query !== 'string') {
    throw new BridgeBadRequestError('/workspace/grep expects query to be a string.');
  }

  return {
    query: body.query,
    options: parseWorkspaceGrepOptions('options' in body ? body.options : undefined),
  };
}

function parseExecSharedOptions(
  route: '/exec/run' | '/exec/shell',
  value: unknown,
): BridgeExecSharedOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BridgeBadRequestError(`${route} expects options to be a JSON object.`);
  }

  const parsed: BridgeExecSharedOptions = {};

  if ('cwd' in value && value.cwd !== undefined) {
    if (typeof value.cwd !== 'string') {
      throw new BridgeBadRequestError(`${route} expects options.cwd to be a string when provided.`);
    }

    if (value.cwd.includes('\0')) {
      throw new BridgeBadRequestError(`${route} does not allow NUL bytes in options.cwd.`);
    }

    parsed.cwd = value.cwd;
  }

  if ('stdin' in value && value.stdin !== undefined) {
    if (typeof value.stdin !== 'string') {
      throw new BridgeBadRequestError(
        `${route} expects options.stdin to be a string when provided.`,
      );
    }

    parsed.stdin = value.stdin;
  }

  if ('timeoutMs' in value && value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs !== 'number' ||
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

  if ('env' in value && value.env !== undefined) {
    if (typeof value.env !== 'object' || value.env === null || Array.isArray(value.env)) {
      throw new BridgeBadRequestError(
        `${route} expects options.env to be an object when provided.`,
      );
    }

    const env: Record<string, string> = {};
    for (const [name, entryValue] of Object.entries(value.env)) {
      if (name === 'PATH') {
        throw new BridgeBadRequestError(`${route} does not allow overriding options.env.PATH.`);
      }

      if (typeof entryValue !== 'string') {
        throw new BridgeBadRequestError(`${route} expects options.env.${name} to be a string.`);
      }

      env[name] = entryValue;
    }

    parsed.env = env;
  }

  if ('envKeys' in value && value.envKeys !== undefined) {
    if (!Array.isArray(value.envKeys)) {
      throw new BridgeBadRequestError(
        `${route} expects options.envKeys to be a string array when provided.`,
      );
    }

    const envKeys: string[] = [];
    for (const entry of value.envKeys) {
      if (typeof entry !== 'string') {
        throw new BridgeBadRequestError(
          `${route} expects every options.envKeys entry to be a string.`,
        );
      }

      if (entry === 'PATH') {
        throw new BridgeBadRequestError(`${route} does not allow options.envKeys to include PATH.`);
      }

      envKeys.push(entry);
    }

    parsed.envKeys = envKeys;
  }

  if ('includeSecrets' in value && value.includeSecrets !== undefined) {
    if (typeof value.includeSecrets !== 'boolean') {
      throw new BridgeBadRequestError(
        `${route} expects options.includeSecrets to be a boolean when provided.`,
      );
    }

    parsed.includeSecrets = value.includeSecrets;
  }

  return parsed;
}

export function parseExecRunRequest(body: unknown): ExecRunOptions {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/exec/run expects a JSON object.');
  }

  if (!('options' in body)) {
    throw new BridgeBadRequestError('/exec/run expects options to be present.');
  }

  const shared = parseExecSharedOptions('/exec/run', body.options);
  if (
    typeof body.options !== 'object' ||
    body.options === null ||
    Array.isArray(body.options) ||
    !('command' in body.options) ||
    typeof body.options.command !== 'string'
  ) {
    throw new BridgeBadRequestError('/exec/run expects options.command to be a string.');
  }

  if (body.options.command.includes('\0')) {
    throw new BridgeBadRequestError('/exec/run does not allow NUL bytes in options.command.');
  }

  if (body.options.command === '') {
    throw new BridgeBadRequestError('/exec/run does not allow an empty options.command.');
  }

  let args: readonly string[] | undefined;
  if ('args' in body.options && body.options.args !== undefined) {
    if (!Array.isArray(body.options.args)) {
      throw new BridgeBadRequestError(
        '/exec/run expects options.args to be a string array when provided.',
      );
    }

    const parsedArgs: string[] = [];
    for (const entry of body.options.args) {
      if (typeof entry !== 'string') {
        throw new BridgeBadRequestError(
          '/exec/run expects every options.args entry to be a string.',
        );
      }

      if (entry.includes('\0')) {
        throw new BridgeBadRequestError(
          '/exec/run does not allow NUL bytes in options.args entries.',
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

export function parseExecShellRequest(body: unknown): ExecShellOptions {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/exec/shell expects a JSON object.');
  }

  if (!('options' in body)) {
    throw new BridgeBadRequestError('/exec/shell expects options to be present.');
  }

  const shared = parseExecSharedOptions('/exec/shell', body.options);
  if (
    typeof body.options !== 'object' ||
    body.options === null ||
    Array.isArray(body.options) ||
    !('script' in body.options) ||
    typeof body.options.script !== 'string'
  ) {
    throw new BridgeBadRequestError('/exec/shell expects options.script to be a string.');
  }

  if (body.options.script.includes('\0')) {
    throw new BridgeBadRequestError('/exec/shell does not allow NUL bytes in options.script.');
  }

  return {
    script: body.options.script,
    ...shared,
  };
}

export function parseEnvKeysRequest(body: unknown): {
  classification: EnvClassification;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/env/keys expects a JSON object.');
  }

  if (!('classification' in body)) {
    throw new BridgeBadRequestError('/env/keys expects classification to be present.');
  }

  return {
    classification: parseEnvClassification(body.classification, 'classification'),
  };
}

export function parseEnvGetRequest(body: unknown): {
  name: string;
  classification: EnvClassification;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/env/get expects a JSON object.');
  }

  if (!('name' in body) || typeof body.name !== 'string') {
    throw new BridgeBadRequestError('/env/get expects name to be a string.');
  }

  if (!('classification' in body)) {
    throw new BridgeBadRequestError('/env/get expects classification to be present.');
  }

  return {
    name: body.name,
    classification: parseEnvClassification(body.classification, 'classification'),
  };
}

export function parseObserveEmitRequest(body: unknown): {
  event: Omit<ObservabilityEvent, 'timestamp'>;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BridgeBadRequestError('/observe/emit expects a JSON object.');
  }

  if (
    !('event' in body) ||
    typeof body.event !== 'object' ||
    body.event === null ||
    Array.isArray(body.event)
  ) {
    throw new BridgeBadRequestError('/observe/emit expects event to be a JSON object.');
  }

  if (!('action' in body.event) || typeof body.event.action !== 'string') {
    throw new BridgeBadRequestError('/observe/emit expects event.action to be a string.');
  }

  if (!('scope' in body.event)) {
    throw new BridgeBadRequestError('/observe/emit expects event.scope to be present.');
  }

  if (!('outcome' in body.event)) {
    throw new BridgeBadRequestError('/observe/emit expects event.outcome to be present.');
  }

  const event: Omit<ObservabilityEvent, 'timestamp'> = {
    scope: parseObservabilityScope(body.event.scope),
    action: body.event.action,
    outcome: parseObservabilityOutcome(body.event.outcome),
  };

  if ('target' in body.event && body.event.target !== undefined) {
    if (typeof body.event.target !== 'string') {
      throw new BridgeBadRequestError(
        '/observe/emit expects event.target to be a string when provided.',
      );
    }

    event.target = body.event.target;
  }

  if ('detail' in body.event && body.event.detail !== undefined) {
    if (typeof body.event.detail !== 'string') {
      throw new BridgeBadRequestError(
        '/observe/emit expects event.detail to be a string when provided.',
      );
    }

    event.detail = body.event.detail;
  }

  return { event };
}
