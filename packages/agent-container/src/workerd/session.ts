import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

import type {
  ObservabilityEvent,
  WorkerdRunErrorDetails,
  WorkerdRunInput,
  WorkerdRunOptions,
  WorkerdRunResult,
  WorkerdSession,
  WorkerdSessionOptions,
} from "@agent-container/types";

import { LocalCapabilityBridgeServer, type SessionCapabilityContext } from "../bridge.js";
import { findFreePort, findWorkerdBinary } from "./binary.js";
import { buildConfig } from "./config.js";
import { workerHarnessSource } from "./harness.js";
import { prepareWorkerdRun, type PreparedWorkerdRun } from "./module-graph.js";

type EmitEvent = (event: Omit<ObservabilityEvent, "timestamp">) => Promise<void>;

interface ParsedRunResponse {
  result: unknown;
  logs: readonly string[];
  error?: WorkerdRunErrorDetails;
}

function parseRunErrorDetails(value: unknown): WorkerdRunErrorDetails {
  if (typeof value === "string") {
    return { message: value };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("workerd returned an invalid error response.");
  }

  if (!("message" in value) || typeof value.message !== "string") {
    throw new Error("workerd returned an invalid error response.");
  }

  const details: WorkerdRunErrorDetails = {
    message: value.message,
  };

  if ("name" in value && value.name !== undefined) {
    if (typeof value.name !== "string") {
      throw new Error("workerd returned an invalid error response.");
    }

    details.name = value.name;
  }

  if ("stack" in value && value.stack !== undefined) {
    if (typeof value.stack !== "string") {
      throw new Error("workerd returned an invalid error response.");
    }

    details.stack = value.stack;
  }

  return details;
}

function parseRunResponse(payload: unknown): ParsedRunResponse {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("workerd returned an invalid run response.");
  }

  const result = "result" in payload ? payload.result : null;

  let logs: readonly string[] = [];
  if ("logs" in payload && payload.logs !== undefined) {
    if (!Array.isArray(payload.logs) || payload.logs.some((entry) => typeof entry !== "string")) {
      throw new Error("workerd returned logs in an invalid format.");
    }

    logs = payload.logs;
  }

  let error: WorkerdRunErrorDetails | undefined;
  if ("error" in payload && payload.error !== undefined) {
    error = parseRunErrorDetails(payload.error);
  }

  return { result, logs, error };
}

export class WorkerdRunError extends Error {
  public readonly guestName: string | undefined;

  public readonly guestStack: string | undefined;

  public readonly logs: readonly string[];

  public constructor(details: WorkerdRunErrorDetails, logs: readonly string[]) {
    super(details.message);
    this.name = "WorkerdRunError";
    this.guestName = details.name;
    this.guestStack = details.stack;
    this.logs = logs;
  }
}

async function waitForReady(options: {
  port: number;
  timeoutMs: number;
  process: ChildProcessByStdio<null, Readable, Readable>;
}): Promise<void> {
  const startedAt = Date.now();
  let processFailure: Error | undefined;

  const onError = (error: Error): void => {
    processFailure = error;
  };

  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const status = signal === null ? `code ${code ?? 0}` : `signal ${signal}`;
    processFailure = new Error(`workerd exited before becoming ready (${status}).`);
  };

  options.process.once("error", onError);
  options.process.once("exit", onExit);

  try {
    while (Date.now() - startedAt < options.timeoutMs) {
      if (processFailure !== undefined) {
        throw processFailure;
      }

      try {
        // eslint-disable-next-line no-await-in-loop -- readiness probes must stay serialized so we do not stack overlapping fetches
        const response = await fetch(`http://127.0.0.1:${options.port}/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Keep waiting until the server is reachable.
      }

      // eslint-disable-next-line no-await-in-loop -- polling intentionally waits between attempts instead of spawning concurrent timers
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (processFailure !== undefined) {
      throw processFailure;
    }

    throw new Error(`workerd failed to become ready within ${options.timeoutMs}ms`);
  } finally {
    options.process.off("error", onError);
    options.process.off("exit", onExit);
  }
}

async function terminateProcess(
  child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<void> {
  if (child.exitCode !== null && child.stdout.destroyed && child.stderr.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    let forceResolveTimeout: ReturnType<typeof setTimeout> | undefined;

    const finalize = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (killTimeout !== undefined) {
        clearTimeout(killTimeout);
      }
      if (forceResolveTimeout !== undefined) {
        clearTimeout(forceResolveTimeout);
      }

      child.off("close", finalize);
      child.off("error", finalize);
      resolve();
    };

    child.once("close", finalize);
    child.once("error", finalize);

    if (child.exitCode === null) {
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => {
        if (settled || child.exitCode !== null) {
          return;
        }

        child.kill("SIGKILL");
      }, 1_000);
    }

    forceResolveTimeout = setTimeout(finalize, 2_000);
  });
}

export class LocalWorkerdSession implements WorkerdSession {
  public port: number;

  readonly #options: WorkerdSessionOptions;

  readonly #context: SessionCapabilityContext;

  readonly #emit: EmitEvent | undefined;

  #status: "created" | "started" | "stopped" = "created";

  #process: ChildProcessByStdio<null, Readable, Readable> | undefined;

  #tempDir: string | undefined;

  #stdout = "";

  #stderr = "";

  #bridge: LocalCapabilityBridgeServer | undefined;

  #runQueue: Promise<void> = Promise.resolve();

  private constructor(
    port: number,
    options: WorkerdSessionOptions,
    context: SessionCapabilityContext,
    emit?: EmitEvent,
  ) {
    this.port = port;
    this.#options = options;
    this.#context = context;
    this.#emit = emit;
  }

  public static async create(
    options: WorkerdSessionOptions = {},
    context: SessionCapabilityContext = {},
    emit?: EmitEvent,
  ): Promise<LocalWorkerdSession> {
    return new LocalWorkerdSession(await findFreePort(), options, context, emit);
  }

  public get status(): "created" | "started" | "stopped" {
    return this.#status;
  }

  public async start(): Promise<void> {
    await this.#startWithPreparedRun(undefined);
  }

  async #startWithPreparedRun(preparedRun: PreparedWorkerdRun | undefined): Promise<void> {
    if (this.#status === "started") {
      return;
    }

    const workerdBinary = await findWorkerdBinary(this.#options.workerdBinary);
    this.port = await findFreePort();
    const tempDir = await mkdtemp(join(tmpdir(), "agent-container-workerd-"));
    this.#tempDir = tempDir;

    try {
      this.#bridge = await LocalCapabilityBridgeServer.create(this.#context, this.#emit);

      const runnerModule = {
        name: "worker.js",
        fileName: "worker.js",
        kind: "esModule" as const,
        content: workerHarnessSource(preparedRun?.entryModuleName),
      };
      const modules = [runnerModule, ...(preparedRun?.modules ?? [])];

      for (const module of modules) {
        const filePath = join(tempDir, module.fileName);
        await mkdir(dirname(filePath), { recursive: true });
        if (typeof module.content === "string") {
          await writeFile(filePath, module.content, "utf8");
        } else {
          await writeFile(filePath, module.content);
        }
      }
      await writeFile(
        join(tempDir, "config.capnp"),
        buildConfig(this.port, this.#bridge.port, this.#bridge.token, {
          ...this.#options,
          modules,
        }),
        "utf8",
      );

      const child = spawn(
        workerdBinary,
        ["serve", join(tempDir, "config.capnp"), "config", "--experimental"],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      this.#process = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.#stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        this.#stderr += chunk;
      });

      await waitForReady({
        port: this.port,
        timeoutMs: this.#options.startupTimeoutMs ?? 30_000,
        process: child,
      });

      this.#status = "started";
      await this.#emitEvent({
        scope: "container",
        action: "workerd.start",
        outcome: "success",
        detail: `port=${this.port}`,
      });
    } catch (error) {
      await this.stop();
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to start workerd session: ${reason}${this.#stderr === "" ? "" : `\n${this.#stderr}`}`,
        { cause: error },
      );
    }
  }

  public async run(
    input: WorkerdRunInput,
    options: WorkerdRunOptions = {},
  ): Promise<WorkerdRunResult> {
    const previousRun = this.#runQueue;
    let releaseRun = (): void => {};
    this.#runQueue = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    await previousRun;
    try {
      return await this.#runUnlocked(input, options);
    } finally {
      releaseRun();
    }
  }

  async #runUnlocked(
    input: WorkerdRunInput,
    options: WorkerdRunOptions,
  ): Promise<WorkerdRunResult> {
    const preparedRun = await prepareWorkerdRun({
      input,
      options,
      workspace: this.#context.workspace,
    });
    await this.stop();
    await this.#startWithPreparedRun(preparedRun);

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userEnv: options.env ?? {},
          input: options.input,
          exportName: options.exportName,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.#emitEvent({
        scope: "container",
        action: "workerd.run",
        outcome: "error",
        detail,
      });
      throw new Error(`Failed to run workerd session: ${detail}`, { cause: error });
    }

    let body: ParsedRunResponse;
    try {
      body = parseRunResponse(await response.json());
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.#emitEvent({
        scope: "container",
        action: "workerd.run",
        outcome: "error",
        detail,
      });
      throw new Error(`Failed to parse workerd run response: ${detail}`, { cause: error });
    }

    const durationMs = performance.now() - startedAt;
    if (body.error !== undefined) {
      await this.#emitEvent({
        scope: "container",
        action: "workerd.run",
        outcome: "error",
        detail: body.error.message,
      });
      throw new WorkerdRunError(body.error, body.logs);
    }

    if (!response.ok) {
      const detail = `workerd run failed with status ${response.status}.`;
      await this.#emitEvent({
        scope: "container",
        action: "workerd.run",
        outcome: "error",
        detail,
      });
      throw new Error(detail);
    }

    await this.#emitEvent({
      scope: "container",
      action: "workerd.run",
      outcome: "success",
      detail: `${durationMs.toFixed(2)}ms`,
    });

    return {
      result: body.result,
      logs: body.logs,
      durationMs,
    };
  }

  public async stop(): Promise<void> {
    if (this.#status === "stopped") {
      return;
    }

    const process = this.#process;
    this.#process = undefined;
    if (process !== undefined) {
      await terminateProcess(process);
      process.stdout.destroy();
      process.stderr.destroy();
    }

    if (this.#tempDir !== undefined) {
      await rm(this.#tempDir, { recursive: true, force: true });
      this.#tempDir = undefined;
    }

    if (this.#bridge !== undefined) {
      await this.#bridge.stop();
      this.#bridge = undefined;
    }

    this.#status = "stopped";
    await this.#emitEvent({
      scope: "container",
      action: "workerd.stop",
      outcome: "success",
      detail: `stdout=${this.#stdout.length} stderr=${this.#stderr.length}`,
    });
  }

  async #emitEvent(event: Omit<ObservabilityEvent, "timestamp">): Promise<void> {
    if (this.#emit === undefined) {
      return;
    }

    await this.#emit(event);
  }
}
