import { spawn } from "node:child_process";

import type {
  ExecController,
  ExecPolicy,
  ExecRunOptions,
  ExecRunResult,
  ExecShellOptions,
  ObservabilityEvent,
  ResolvedEnv,
  WorkspaceController,
} from "@agent-container/types";

type EmitEvent = (event: Omit<ObservabilityEvent, "timestamp">) => Promise<void>;

const maxTimerDelayMs = 2_147_483_647;

function resolveTimeoutMs(value: number | undefined, fallback: number): number {
  const timeoutMs = value ?? fallback;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > maxTimerDelayMs) {
    throw new Error(`timeoutMs must be an integer between 0 and ${maxTimerDelayMs}.`);
  }

  return timeoutMs;
}

function allowCommand(command: string, policy?: ExecPolicy): boolean {
  const allowedCommands = policy?.allowedCommands;
  if (allowedCommands === undefined || allowedCommands.length === 0) {
    return true;
  }

  return allowedCommands.includes(command);
}

function buildExecEnv(
  resolvedEnv: ResolvedEnv,
  options: {
    env?: Record<string, string>;
    envKeys?: readonly string[];
    includeSecrets?: boolean;
  },
): Record<string, string> {
  const values: Record<string, string> = {
    PATH: process.env.PATH ?? "",
  };

  const includeSecrets = options.includeSecrets ?? false;
  if (options.envKeys !== undefined) {
    for (const name of options.envKeys) {
      if (name === "PATH") {
        throw new Error("Environment variable is not allowed for exec: PATH");
      }

      const value = resolvedEnv.get(name);
      const classification = resolvedEnv.getClassification(name);
      if (value === undefined || classification === undefined) {
        continue;
      }

      if (!includeSecrets && classification === "secret") {
        continue;
      }

      values[name] = value;
    }
  } else {
    for (const [name, value] of Object.entries(resolvedEnv.toObject({ includeSecrets }))) {
      if (name === "PATH") {
        continue;
      }

      values[name] = value;
    }
  }

  if (options.env !== undefined) {
    for (const [name, value] of Object.entries(options.env)) {
      if (name === "PATH") {
        throw new Error("Environment variable is not allowed for exec: PATH");
      }

      values[name] = value;
    }
  }

  return values;
}

async function collectSpawnResult(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  env: Record<string, string>;
}): Promise<ExecRunResult> {
  return new Promise((resolvePromise, reject) => {
    const timeoutGraceMs = 1_000;
    const startedAt = performance.now();
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (killTimeout !== undefined) {
        clearTimeout(killTimeout);
      }
    };

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      timedOut = true;
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => {
        if (settled) {
          return;
        }

        child.kill("SIGKILL");
      }, timeoutGraceMs);
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimers();
      resolvePromise({
        exitCode: code ?? (signal === null ? 0 : 1),
        stdout,
        stderr,
        timedOut,
        durationMs: performance.now() - startedAt,
      });
    });

    if (options.stdin !== undefined && options.stdin !== "") {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export class LocalExecController implements ExecController {
  readonly #workspace: WorkspaceController;

  readonly #env: ResolvedEnv;

  readonly #policy: ExecPolicy | undefined;

  readonly #emit: EmitEvent | undefined;

  public constructor(options: {
    workspace: WorkspaceController;
    env: ResolvedEnv;
    policy?: ExecPolicy;
    emit?: EmitEvent;
  }) {
    this.#workspace = options.workspace;
    this.#env = options.env;
    this.#policy = options.policy;
    this.#emit = options.emit;
  }

  public async run(options: ExecRunOptions): Promise<ExecRunResult> {
    if (options.command === "") {
      throw new Error("Command must not be empty.");
    }

    if (!allowCommand(options.command, this.#policy)) {
      await this.#emitEvent({
        scope: "exec",
        action: "run-denied",
        outcome: "denied",
        target: options.command,
      });
      throw new Error(`Command is not allowed: ${options.command}`);
    }

    try {
      const cwd = await this.#workspace.resolvePath(options.cwd ?? ".");
      const result = await collectSpawnResult({
        command: options.command,
        args: options.args ?? [],
        cwd,
        stdin: options.stdin,
        timeoutMs: resolveTimeoutMs(options.timeoutMs, this.#policy?.defaultTimeoutMs ?? 30_000),
        env: buildExecEnv(this.#env, options),
      });
      await this.#emitEvent({
        scope: "exec",
        action: "run",
        outcome: result.exitCode === 0 && !result.timedOut ? "success" : "error",
        target: options.command,
        detail: `exit=${result.exitCode} timeout=${result.timedOut}`,
      });
      return result;
    } catch (error) {
      await this.#emitFailure("run", options.command, error);
      throw error;
    }
  }

  public async shell(options: ExecShellOptions): Promise<ExecRunResult> {
    if (!(this.#policy?.allowShell ?? false)) {
      await this.#emitEvent({
        scope: "exec",
        action: "shell-denied",
        outcome: "denied",
        target: options.script,
      });
      throw new Error("Shell execution is not allowed.");
    }

    try {
      const shellPath = process.env.SHELL ?? "/bin/sh";
      const cwd = await this.#workspace.resolvePath(options.cwd ?? ".");
      const result = await collectSpawnResult({
        command: shellPath,
        args: ["-lc", options.script],
        cwd,
        stdin: options.stdin,
        timeoutMs: resolveTimeoutMs(options.timeoutMs, this.#policy?.defaultTimeoutMs ?? 30_000),
        env: buildExecEnv(this.#env, options),
      });
      await this.#emitEvent({
        scope: "exec",
        action: "shell",
        outcome: result.exitCode === 0 && !result.timedOut ? "success" : "error",
        detail: `exit=${result.exitCode} timeout=${result.timedOut}`,
      });
      return result;
    } catch (error) {
      await this.#emitFailure("shell", options.script, error);
      throw error;
    }
  }

  async #emitEvent(event: Omit<ObservabilityEvent, "timestamp">): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    await this.#emit(event);
  }

  async #emitFailure(action: string, target: string, error: unknown): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    await this.#emit({
      scope: "exec",
      action,
      outcome: "error",
      target,
      detail,
    });
  }
}
