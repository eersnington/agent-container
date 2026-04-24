# Agent Container

### Give your agents tiny boxes, powered by [workerd](https://github.com/cloudflare/workerd)

> ⚠️ This project is under active development. APIs may change.

Agent Container is a small runtime layer for running agent-generated code against a workspace through capability bindings.

The core idea is that a workspace should not have to be the process working directory, the filesystem authority boundary, the command execution boundary, and the environment boundary all at once. Instead, the host owns the real authority and projects only the intended pieces into `workerd` as live bindings:

```ts
const pkg = await WORKSPACE.readText("package.json");
const { stdout } = await EXEC.run({ command: "node", args: ["--version"] });
const apiUrl = await ENV.get("API_URL");
```

rather than handing agent code raw host APIs:

```ts
const pkg = await fs.readFile("/Users/me/project/package.json", "utf8");
const { stdout } = await execFile("node", ["--version"]);
const apiUrl = process.env.API_URL;
```

That distinction is the point of this project. Agent Container gives coding agent harnesses a capability-bound execution model: guest code runs in `workerd`, while the Node.js host brokers filesystem access, subprocess execution, environment values, network policy, and observability through explicit bindings.

---

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#why">Why</a> &middot;
  <a href="#threat-model">Threat Model</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#bindings">Bindings</a> &middot;
  <a href="#api">API</a> &middot;
  <a href="#development">Development</a>
</p>

---

## Quick Start

```ts
import { createAgentContainer } from "agent-container";

const container = await createAgentContainer({
  workspace: {
    root: process.cwd(),
    mode: "shadow", // run against a disposable copy of the workspace
  },
  env: {
    include: ["PUBLIC_*", "APP_*"],
  },
  exec: {
    allowedCommands: ["node", "git"],
  },
  network: {
    allowFetch: false,
  },
});

await container.start();

const session = await container.createWorkerdSession();

const { result } = await session.run(
  `
    export async function run({ input, WORKSPACE, EXEC }) {
      const pkg = await WORKSPACE.readText(input.packagePath);
      const { stdout } = await EXEC.run({ command: "node", args: ["--version"] });
      return { name: JSON.parse(pkg).name, node: stdout.trim() };
    }
  `,
  {
    language: "ts",
    input: { packagePath: "package.json" },
  },
);

console.log(result);
// { name: "my-project", node: "v22.0.0" }

await session.stop();
await container.stop();
```

Code inside the `workerd` session does not get Node's `fs`, `process`, or `child_process` APIs. It gets the bindings the host chooses to expose.

## Why

Most coding agent harnesses gets tools like read, write, edit, grep, bash, and git. Those tools often run on the host system with the project directory acting as a soft boundary. That works, but it makes the working directory do too many jobs:

- workspace root
- execution boundary
- filesystem authority boundary
- environment boundary
- audit boundary

Those are different concerns.

Agent Container separates them. The workspace root becomes a scoped `WORKSPACE` object. Command execution becomes an `EXEC` binding with allowlists, timeouts, controlled cwd resolution, and logged outcomes. Environment access becomes `ENV` and `SECRETS`, populated only from selected sources. Network access is configured at the `workerd` session level instead of being assumed.

This follows the Cloudflare Workers resource model, where bindings carry both permission and API as runtime objects. In an agent harness, the same model maps cleanly to the resources an agent needs for coding work.

## Threat Model

Agent Container should not be described as a secure sandbox for fully untrusted code.

It reduces ambient authority by moving access behind bindings, but the host still brokers real filesystem and subprocess operations. `EXEC.run` still starts real host subprocesses. `WORKSPACE` still maps to real files or a copied workspace. The bridge is session-local and token-gated, but it is not a replacement for VM, container, kernel, or production-grade isolation when running adversarial code.

`workerd` network policy applies to the guest runtime, not to subprocesses started through `EXEC.run`. A permitted command runs as a host subprocess with the configured cwd, environment projection, timeout, and command policy.

The goal is narrower and more useful for coding agents: do not give generated code broad host authority by default. Give it explicit capabilities that a harness can inspect, constrain, and log.

## How It Works

```
HOST (Node.js)

  Workspace Controller       Env Resolver          Exec Controller
  - live/shadow roots        - .env files          - command allowlist
  - ro/rw mounts             - inline values       - cwd inside workspace
  - path containment         - process env policy  - timeouts
  - list/stat/glob/grep      - secret classes      - structured results

            \                    |                    /
             \                   |                   /
              +--------- Capability Bridge ----------+
                        localhost HTTP + token
                                 |
                                 v

GUEST (workerd)

  JavaScript runs with explicit bindings:

  WORKSPACE    EXEC        ENV        SECRETS      OBSERVE
  read/write   run/shell   get/keys   get/keys     emit
  list/stat
  glob/grep
  remove
```

The `workerd` harness runs JavaScript or TypeScript modules and passes capability bindings through a `run(ctx)` export. Those binding methods call a session-local bridge. The bridge validates JSON requests, checks the configured policy through the host controllers, performs the operation, and emits observability events when configured.

## Current Surface

Implemented today:

- `createAgentContainer(options)` assembles workspace, env, exec, network, and observability policy.
- `container.createWorkerdSession()` starts a real `workerd` process with a generated config.
- `WORKSPACE` supports `readText`, `writeText`, `list`, `stat`, `glob`, `grep`, and `remove`.
- Workspace mode can be `live` or `shadow`; `shadow` copies the workspace to a disposable temp directory.
- Workspace mounts can expose additional paths as read-only or read-write logical mount points.
- Workspace reads are env-aware: root `.env*` sources are exposed as filtered dotenv views, and env-like files outside configured env sources are denied.
- `workspace.denyRead` can deny additional non-env paths from `WORKSPACE.readText` and `WORKSPACE.grep`.
- `EXEC.run` starts allowlisted host commands with workspace-scoped cwd resolution, timeout handling, and selected env projection.
- `EXEC.shell` exists, but only works when `allowShell` is enabled.
- `ENV` exposes public variables and `SECRETS` exposes secret-classified variables.
- `OBSERVE.emit` lets guest code add structured events to the host observability sink.
- `workerd` outbound fetch is disabled by default and can be enabled with optional origin filtering.
- `session.run()` accepts code or workspace path sources, transpiles TypeScript/TSX per file, and preserves the `workerd` module graph for static relative imports.

Not implemented yet (WIP):

- a first-class `NET` binding
- narrow workspace change primitives such as `diff`, `statusSummary`, `snapshot`, and `applyPatch`

## Bindings

### WORKSPACE

`WORKSPACE` is the project-shaped view given to agent code.

```ts
const content = await WORKSPACE.readText("src/index.ts");
await WORKSPACE.writeText("notes/result.json", JSON.stringify(data, null, 2));

const entries = await WORKSPACE.list("src");
const info = await WORKSPACE.stat("package.json");

const files = await WORKSPACE.glob(["src/**/*.ts", "README.md"]);
const matches = await WORKSPACE.grep("TODO", {
  include: "**/*.ts",
  caseSensitive: false,
  maxResults: 20,
});
```

Modes:

- `live` operates on the configured root.
- `shadow` copies the configured root to a temporary directory and operates there.

Mounts:

```ts
const container = await createAgentContainer({
  workspace: {
    root: process.cwd(),
    mounts: [
      { mountPath: "/docs", sourcePath: "/path/to/docs", mode: "ro" },
      { mountPath: "/scratch", sourcePath: "/path/to/scratch", mode: "rw" },
    ],
  },
});
```

The workspace controller resolves logical paths against the matching mount and rejects path traversal outside that mount's physical root.

Env file reads:

```ts
const container = await createAgentContainer({
  workspace: { root: process.cwd() },
  env: {
    include: ["PUBLIC_*"],
    processEnv: "none",
  },
});

const envFile = await WORKSPACE.readText(".env");
// PUBLIC_READ_KEY="hello-world"
```

If `env.sources` is omitted, root-level `.env` and `.env.*` files are treated as env sources. Reading one of those files through `WORKSPACE` returns a synthetic dotenv file filtered by the same `env.include` and `env.exclude` rules used by `ENV`.

If `env.sources` is provided, only those file sources are readable as filtered env files. Other env-like files, such as `.env.local` when only `.env` is configured, are denied with `Path is not readable: <path>`.

Additional read denies:

```ts
const container = await createAgentContainer({
  workspace: {
    root: process.cwd(),
    denyRead: ["**/*.secret"],
  },
});
```

`denyRead` applies to non-env file content reads and search. It does not select env sources; use `env.sources` for that. `list`, `stat`, and `glob` may still reveal filenames.

### EXEC

`EXEC` is brokered subprocess execution.

```ts
const result = await EXEC.run({
  command: "node",
  args: ["--version"],
  timeoutMs: 5_000,
});

console.log(result.stdout, result.exitCode);
```

Policy:

```ts
const container = await createAgentContainer({
  workspace: { root: process.cwd() },
  exec: {
    allowedCommands: ["node", "git"],
    allowShell: false,
    defaultTimeoutMs: 30_000,
  },
});
```

Environment projection into subprocesses is explicit:

```ts
await EXEC.run({
  command: "node",
  args: ["script.js"],
  envKeys: ["PUBLIC_MODE"],
  env: { EXTRA_FLAG: "1" },
});
```

Secrets are excluded from subprocess env by default, even when listed in `envKeys`. Use `includeSecrets: true` only when the command genuinely needs them.

### ENV and SECRETS

`ENV` and `SECRETS` expose selected configuration values without giving the guest raw `process.env`.

```ts
const mode = await ENV.get("PUBLIC_MODE");
const publicKeys = await ENV.keys();

const token = await SECRETS.get("API_SECRET_TOKEN");
const secretKeys = await SECRETS.keys();
```

Env policy can load from root `.env*` files, explicit file sources, inline values, and selected process env values:

```ts
const container = await createAgentContainer({
  workspace: { root: process.cwd() },
  env: {
    include: ["PUBLIC_*", "API_SECRET_*"],
    exclude: ["PUBLIC_DEBUG_ONLY"],
    processEnv: "allow-matching",
    secretPatterns: ["*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD"],
  },
});
```

When `sources` is omitted, Agent Container discovers root-level `.env` and `.env.*` files. When `sources` is provided, only those sources are used.

```ts
const container = await createAgentContainer({
  workspace: { root: process.cwd() },
  env: {
    sources: [{ type: "file", path: ".env" }],
    include: ["PUBLIC_*"],
    processEnv: "none",
  },
});
```

### Network

There is no first-class `NET` binding yet. Current network policy controls `workerd`'s global outbound fetch behavior:

```ts
const session = await container.createWorkerdSession({
  allowFetch: true,
  allowedFetchOrigins: ["api.example.com"],
});
```

By default, outbound fetch is blocked. If `allowedFetchOrigins` is set, the generated `workerd` config routes requests through a filtering worker before public network access.

### OBSERVE

Host-side controllers emit structured events for container lifecycle, workspace operations, env resolution, exec outcomes, and `workerd` runs.

```ts
const events = [];

const container = await createAgentContainer({
  workspace: { root: process.cwd() },
  observability: {
    emit(event) {
      events.push(event);
    },
  },
});
```

Guest code can also emit events:

```ts
await OBSERVE.emit({
  scope: "workspace",
  action: "custom-check",
  outcome: "success",
  detail: "validated generated files",
});
```

## API

### createAgentContainer(options)

```ts
interface AgentContainerOptions {
  workspace: {
    root: string;
    mode?: "live" | "shadow";
    mounts?: readonly {
      mountPath: string;
      sourcePath: string;
      mode: "ro" | "rw";
    }[];
    denyRead?: readonly string[];
  };
  env?: {
    sources?: readonly EnvSource[];
    include?: readonly string[];
    exclude?: readonly string[];
    publicPatterns?: readonly string[];
    secretPatterns?: readonly string[];
    processEnv?: "none" | "allow-matching" | "all";
  };
  exec?: {
    allowedCommands?: readonly string[];
    allowShell?: boolean;
    defaultTimeoutMs?: number;
  };
  network?: {
    allowFetch?: boolean;
    allowedFetchOrigins?: readonly string[];
  };
  observability?: {
    emit(event: ObservabilityEvent): void | Promise<void>;
  };
}
```

### container.createWorkerdSession(options?)

```ts
const session = await container.createWorkerdSession({
  startupTimeoutMs: 30_000,
  compatibilityDate: "2026-04-20",
  allowFetch: false,
});

const { result, logs, durationMs } = await session.run(
  { path: "scripts/check.ts" },
  { timeoutMs: 5_000 },
);

await session.stop();
```

### defineAgentContainerPlugin(options)

Defines a small plugin descriptor that agent harnesses can use to map their tool names to Agent Container bindings.

```ts
const plugin = defineAgentContainerPlugin({
  name: "my-agent",
  container: {
    workspace: { root: "." },
    exec: { allowedCommands: ["node"] },
  },
  tools: {
    read: "WORKSPACE.readText",
    bash: "EXEC.run",
  },
});
```

## Project Structure

```
packages/
├── agent-container/    # Core runtime, controllers, bridge, workerd session
├── types/              # Shared TypeScript types
├── cli/                # CLI tools
└── test-utils/         # Test helpers

apps/
├── e2e/                # End-to-end harness tests
├── playground/         # Development playground (WIP)
└── docs/               # Documentation (WIP)
```

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
```

### CLI (WIP)

```sh
agent-container describe
```

`describe` prints the container description for the current directory.

## License

[Apache-2.0](LICENSE)
