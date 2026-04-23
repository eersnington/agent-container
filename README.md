<h3 align="center">agent-container</h3>

<p align="center">
  Give your agents tiny boxes, powered by <a href="https://github.com/cloudflare/workerd">workerd</a><br />
  Agent Container is a workerd-based sandbox designed to give coding agents isolated execution environments, providing structured bindings (workspace, exec, env) scoped to a single repository rather than the host system. It's ideal for AI coding tools, agent frameworks, and platforms that need to run untrusted code with fine-grained capability control.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#why">Why</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
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
    mode: "shadow", // disposable copy of your repo
  },
  env: {
    include: ["PUBLIC_*", "APP_*"],
  },
  exec: {
    allowedCommands: ["node", "git"],
  },
});

await container.start();

const session = await container.createWorkerdSession();
await session.start();

const { result } = await session.run({
  code: `
    const pkg = await WORKSPACE.readText("package.json");
    const { stdout } = await EXEC.run({ command: "node", args: ["--version"] });
    return { name: JSON.parse(pkg).name, node: stdout.trim() };
  `,
});

console.log(result);
// { name: "my-project", node: "v22.0.0" }

await session.stop();
await container.stop();
```

The code inside `workerd` cannot access `fs`, `process`, or `child_process` directly. It operates through explicit capability bindings that the host controls.


## Why

Coding agents need to work inside real projects: reading files, writing code, running scripts, using environment variables. But giving an agent unrestricted access to your machine is dangerous, and dropping it into a fake environment breaks too many real-world workflows.

**agent-container** solves this by running agent code inside [workerd](https://github.com/cloudflare/workerd) while keeping all real authority in a Node.js host process. The agent gets a natural development experience. You keep control.

| Problem | Solution |
|---------|----------|
| Agent sees `~`, `.ssh`, unrelated directories | Workspace-scoped filesystem with explicit mounts |
| Agent reads raw `.env` files | Env resolution with secret classification |
| Agent spawns arbitrary processes | Allowlisted command execution with timeouts |
| Agent has ambient network access | Controlled fetch with origin restrictions |
| Hard to audit agent actions | Structured observability events |


## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HOST (Node.js)                                                             │
│                                                                             │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │   Workspace     │  │      Env        │  │      Exec       │              │
│  │   Controller    │  │    Resolver     │  │   Controller    │              │
│  │                 │  │                 │  │                 │              │
│  │  • live/shadow  │  │  • .env files   │  │  • allowlist    │              │
│  │  • mounts       │  │  • process.env  │  │  • timeouts     │              │
│  │  • read/write   │  │  • secrets      │  │  • shell policy │              │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              │
│           │                    │                    │                       │
│           └────────────────────┼────────────────────┘                       │
│                                │                                            │
│                    ┌───────────▼───────────┐                                │
│                    │   Capability Bridge   │                                │
│                    │   (localhost HTTP)    │                                │
│                    └───────────┬───────────┘                                │
└────────────────────────────────┼────────────────────────────────────────────┘
                                 │
┌────────────────────────────────┼────────────────────────────────────────────┐
│  GUEST (workerd)               │                                            │
│                                ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        Capability Bindings                           │   │
│  │                                                                      │   │
│  │   WORKSPACE        EXEC           ENV          SECRETS    OBSERVE    │   │
│  │   read/write       run/shell      get/keys     get/keys   emit       │   │
│  │   glob/grep        (allowlist)    (public)     (secret)              │   │
│  │   list/stat                                                          │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  No direct fs, process, or child_process access                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Two runtimes, one boundary:**

- **Host (Node.js)** owns all real authority: filesystem, environment, subprocesses, network policy, observability
- **Guest (workerd)** runs agent code with only the capabilities explicitly granted through bindings

The capability bridge is a session-local HTTP server that maps guest-side binding calls to host-side controllers. Each request is validated, policy-checked, and logged before execution.


## Capabilities

### WORKSPACE

Scoped filesystem access with optional mounts.

```ts
// Read and write files
const content = await WORKSPACE.readText("src/index.ts");
await WORKSPACE.writeText("output/result.json", JSON.stringify(data));

// Search
const files = await WORKSPACE.glob("**/*.ts");
const matches = await WORKSPACE.grep("TODO", { include: "**/*.ts" });

// Inspect
const entries = await WORKSPACE.list("src");
const info = await WORKSPACE.stat("package.json");
```

**Modes:**
- `live` — operate directly on the repo (default)
- `shadow` — operate on a disposable copy

**Mounts:** attach additional paths with `ro` or `rw` access.

### EXEC

Controlled subprocess execution.

```ts
const { stdout, exitCode } = await EXEC.run({
  command: "node",
  args: ["--version"],
  timeoutMs: 5000,
});

// Shell execution (requires allowShell: true)
const result = await EXEC.shell({
  script: "ls -la | head -5",
});
```

**Policy options:**
- `allowedCommands` — whitelist of executables
- `allowShell` — enable/disable shell scripts
- `defaultTimeoutMs` — execution timeout

### ENV / SECRETS

Separated environment variable access.

```ts
// Public config
const apiUrl = await ENV.get("API_URL");
const publicKeys = await ENV.keys();

// Secrets (classified by pattern matching)
const apiKey = await SECRETS.get("API_KEY");
```

**Classification:** variables matching patterns like `*_KEY`, `*_TOKEN`, `*_SECRET` are automatically classified as secrets and isolated from `ENV`.

### OBSERVE

Structured event emission for audit trails.

```ts
await OBSERVE.emit({
  scope: "workspace",
  action: "custom-operation",
  outcome: "success",
  detail: "processed 42 files",
});
```


## API

### createAgentContainer(options)

Creates a container with configured policies.

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
  };
  env?: {
    sources?: readonly EnvSource[];
    include?: readonly string[];
    exclude?: readonly string[];
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

Creates a workerd session for running code.

```ts
const session = await container.createWorkerdSession({
  startupTimeoutMs: 30000,
  compatibilityDate: "2026-01-01",
});

await session.start();
const { result, logs, durationMs } = await session.run({ code: "..." });
await session.stop();
```

### defineAgentContainerPlugin(options)

Defines a plugin for integration with agent harnesses.

```ts
const plugin = defineAgentContainerPlugin({
  name: "my-agent",
  container: { workspace: { root: "." } },
  tools: {
    read: "WORKSPACE.readText",
    bash: "EXEC.run",
  },
});
```


## Project Structure

```
packages/
├── agent-container/    # Core runtime
├── types/              # Shared TypeScript types
├── cli/                # CLI tools
└── test-utils/         # Test helpers

apps/
├── e2e/                # Integration tests
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
# Print container description for current directory
agent-container describe
```

---

## License

[Apache-2.0](LICENSE)
