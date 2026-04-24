function escapeJsString(value: string): string {
  return JSON.stringify(value);
}

function relativeEntrySpecifier(entryModuleName: string): string {
  return entryModuleName.startsWith(".") ? entryModuleName : `./${entryModuleName}`;
}

export function workerHarnessSource(entryModuleName: string | undefined): string {
  const importLine =
    entryModuleName === undefined
      ? "const entryModule = {};"
      : `import * as entryModule from ${escapeJsString(relativeEntrySpecifier(entryModuleName))};`;

  return `${importLine}

function formatValue(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createLogger(logs) {
  return {
    log(...args) {
      logs.push(args.map(formatValue).join(" "));
    },
    error(...args) {
      logs.push(args.map(formatValue).join(" "));
    },
    warn(...args) {
      logs.push(args.map(formatValue).join(" "));
    },
    info(...args) {
      logs.push(args.map(formatValue).join(" "));
    },
  };
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: typeof error.name === "string" && error.name !== "" ? error.name : undefined,
      message: typeof error.message === "string" ? error.message : String(error),
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }

  return {
    message: formatValue(error),
  };
}

function createBridgeBindings(env) {
  async function call(path, payload) {
    const response = await env.CAPABILITY_BRIDGE.fetch(
      new Request("http://bridge" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-container-bridge-token": env.CAPABILITY_BRIDGE_TOKEN,
        },
        body: JSON.stringify(payload ?? {}),
      }),
    );

    const data = await response.json();
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : "Capability bridge request failed.");
    }

    return data.result;
  }

  return {
    WORKSPACE: {
      read(path) {
        return call("/workspace/read-text", { path });
      },
      readText(path) {
        return call("/workspace/read-text", { path });
      },
      write(path, text) {
        return call("/workspace/write-text", { path, text });
      },
      writeText(path, text) {
        return call("/workspace/write-text", { path, text });
      },
      list(path) {
        return call("/workspace/list", { path });
      },
      stat(path) {
        return call("/workspace/stat", { path });
      },
      glob(pattern) {
        return call("/workspace/glob", { pattern });
      },
      grep(query, options) {
        return call("/workspace/grep", { query, options });
      },
      remove(path) {
        return call("/workspace/remove", { path });
      },
    },
    EXEC: {
      run(options) {
        return call("/exec/run", { options });
      },
      shell(options) {
        return call("/exec/shell", { options });
      },
    },
    ENV: {
      keys() {
        return call("/env/keys", { classification: "public" });
      },
      get(name) {
        return call("/env/get", { classification: "public", name });
      },
    },
    SECRETS: {
      keys() {
        return call("/env/keys", { classification: "secret" });
      },
      get(name) {
        return call("/env/get", { classification: "secret", name });
      },
    },
    OBSERVE: {
      emit(event) {
        return call("/observe/emit", { event });
      },
    },
  };
}

async function runModule(body, env, logs) {
  const exportName = typeof body.exportName === "string" ? body.exportName : "run";
  const candidate =
    exportName in entryModule
      ? entryModule[exportName]
      : exportName === "run"
        ? entryModule.default
        : undefined;

  if (typeof candidate !== "function") {
    throw new Error(
      exportName === "run"
        ? "Module must export a run(ctx) function or a default function."
        : "Module export is not a function: " + exportName,
    );
  }

  const bindings = createBridgeBindings(env);
  const logger = createLogger(logs);
  const previousConsole = globalThis.console;
  globalThis.console = logger;
  try {
    return await candidate({
      ...bindings,
      env: body.userEnv ?? {},
      input: body.input,
      console: logger,
    });
  } finally {
    globalThis.console = previousConsole;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }

    if (request.method !== "POST" || url.pathname !== "/run") {
      return new Response("Not Found", { status: 404 });
    }

    const body = await request.json();
    const logs = [];
    try {
      const result = await runModule(body, env, logs);
      return Response.json({ result, logs });
    } catch (error) {
      return Response.json(
        { error: serializeError(error), logs },
        { status: 500 },
      );
    }
  },
};
`;
}
