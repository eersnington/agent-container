export function workerHarnessSource(): string {
  return `function formatValue(value) {
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

async function runCode(code, userEnv, bindings, logs, unsafeEval) {
  const logger = createLogger(logs);
  const state = globalThis.__agentContainerState ?? (globalThis.__agentContainerState = {});
  if (unsafeEval === undefined || typeof unsafeEval.eval !== "function") {
    throw new Error("UnsafeEval binding is not available.");
  }

  const fn = unsafeEval.eval(
    '(async function (env, console, WORKSPACE, EXEC, ENV, SECRETS, OBSERVE, STATE) {"use strict";\\n' +
      code +
      '\\n})',
  );
  if (typeof fn !== "function") {
    throw new Error("UnsafeEval did not produce an executable function.");
  }

  return await fn(
    userEnv ?? {},
    logger,
    bindings.WORKSPACE,
    bindings.EXEC,
    bindings.ENV,
    bindings.SECRETS,
    bindings.OBSERVE,
    state,
  );
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
    const bindings = createBridgeBindings(env);
    try {
      const result = await runCode(
        String(body.code ?? ""),
        body.userEnv ?? {},
        bindings,
        logs,
        env.UNSAFE_EVAL,
      );
      return Response.json({ result, logs });
    } catch (error) {
      return Response.json(
        { error: formatValue(error instanceof Error ? error.message : error), logs },
        { status: 500 },
      );
    }
  },
};
`;
}
