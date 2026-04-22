import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type {
  ObservabilityEvent,
  WorkerdRunOptions,
  WorkerdRunResult,
  WorkerdSession,
  WorkerdSessionOptions,
} from "@agent-container/types";

import { LocalCapabilityBridgeServer, type SessionCapabilityContext } from "../bridge.js";
import { findFreePort, findWorkerdBinary } from "./binary.js";
import { buildConfig } from "./config.js";
import { workerHarnessSource } from "./harness.js";

type EmitEvent = (event: Omit<ObservabilityEvent, "timestamp">) => Promise<void>;

interface ParsedRunResponse {
  result: unknown;
  logs: readonly string[];
  error?: string;
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

  let error: string | undefined;
  if ("error" in payload && payload.error !== undefined) {
    if (typeof payload.error !== "string") {
      throw new Error("workerd returned an invalid error response.");
    }

    error = payload.error;
  }

  return { result, logs, error };
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
        const response = await fetch(`http://127.0.0.1:${options.port}/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Keep waiting until the server is reachable.
      }

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
  public readonly port: number;

  readonly #options: WorkerdSessionOptions;

  readonly #context: SessionCapabilityContext;

  readonly #emit: EmitEvent | undefined;

  #status: "created" | "started" | "stopped" = "created";

  #process: ChildProcessByStdio<null, Readable, Readable> | undefined;

  #tempDir: string | undefined;

  #stdout = "";

  #stderr = "";

  #bridge: LocalCapabilityBridgeServer | undefined;

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
    if (this.#status === "started") {
      return;
    }

    const workerdBinary = await findWorkerdBinary(this.#options.workerdBinary);
    const tempDir = await mkdtemp(join(tmpdir(), "agent-container-workerd-"));
    this.#tempDir = tempDir;

    try {
      this.#bridge = await LocalCapabilityBridgeServer.create(this.#context, this.#emit);

      await writeFile(join(tempDir, "worker.js"), workerHarnessSource(), "utf8");
      await writeFile(
        join(tempDir, "config.capnp"),
        buildConfig(this.port, this.#bridge.port, this.#bridge.token, this.#options),
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
      );
    }
  }

  public async run(options: WorkerdRunOptions): Promise<WorkerdRunResult> {
    if ((options.language ?? "js") !== "js") {
      throw new Error("Only JavaScript execution is currently supported.");
    }

    await this.start();

    const startedAt = performance.now();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: options.code,
          userEnv: options.env ?? {},
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
      throw new Error(`Failed to run workerd session: ${detail}`);
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
      throw new Error(`Failed to parse workerd run response: ${detail}`);
    }

    const durationMs = performance.now() - startedAt;
    if (body.error !== undefined) {
      await this.#emitEvent({
        scope: "container",
        action: "workerd.run",
        outcome: "error",
        detail: body.error,
      });
      throw new Error(body.error);
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
