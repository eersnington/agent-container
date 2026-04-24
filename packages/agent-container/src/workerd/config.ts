import type { WorkerdSessionOptions } from "@agent-container/types";

export const DEFAULT_COMPATIBILITY_DATE = "2026-04-20";

export interface WorkerdConfigModule {
  name: string;
  fileName: string;
  kind: "esModule" | "json" | "text" | "wasm";
}

export interface WorkerdConfigOptions extends WorkerdSessionOptions {
  modules: readonly WorkerdConfigModule[];
}

function escapeCapnpString(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
}

function buildOutboundServices(
  options: Required<Pick<WorkerdSessionOptions, "allowFetch" | "allowedFetchOrigins">>,
): {
  services: string;
  globalOutbound: string;
  extraWorkers: string;
} {
  if (!options.allowFetch) {
    return {
      services: `( name = "blocked", worker = .blockedWorker ),`,
      globalOutbound: '"blocked"',
      extraWorkers: `
const blockedWorker :Workerd.Worker = (
  serviceWorkerScript = "addEventListener('fetch', event => { event.respondWith(new Response('Outbound fetch is blocked.', { status: 403 })); })",
  compatibilityDate = "${DEFAULT_COMPATIBILITY_DATE}",
);`,
    };
  }

  if (options.allowedFetchOrigins.length > 0) {
    const allowedOrigins = JSON.stringify(
      options.allowedFetchOrigins.map((origin) => origin.toLowerCase()),
    );
    const filterScript = escapeCapnpString(
      `addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const hostname = url.hostname.toLowerCase();
  const allowed = ${allowedOrigins};
  const permitted = allowed.some(origin => hostname === origin || hostname.endsWith('.' + origin));
  if (!permitted) {
    event.respondWith(new Response('Fetch to ' + hostname + ' is blocked.', { status: 403 }));
    return;
  }
  event.respondWith(fetch(event.request));
});`,
    );

    return {
      services: `( name = "filter", worker = .filterWorker ),
    ( name = "internet", network = ( allow = ["public"], tlsOptions = (trustBrowserCas = true) ) ),`,
      globalOutbound: '"filter"',
      extraWorkers: `
const filterWorker :Workerd.Worker = (
  serviceWorkerScript = "${filterScript}",
  compatibilityDate = "${DEFAULT_COMPATIBILITY_DATE}",
  globalOutbound = "internet",
);`,
    };
  }

  return {
    services: `( name = "internet", network = ( allow = ["public"], tlsOptions = (trustBrowserCas = true) ) ),`,
    globalOutbound: '"internet"',
    extraWorkers: "",
  };
}

export function buildConfig(
  port: number,
  bridgePort: number,
  bridgeToken: string,
  options: WorkerdConfigOptions,
): string {
  const compatibilityDate = escapeCapnpString(
    options.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
  );
  const compatibilityFlags =
    options.compatibilityFlags === undefined || options.compatibilityFlags.length === 0
      ? ""
      : `\n  compatibilityFlags = [${options.compatibilityFlags
          .map((flag) => `"${escapeCapnpString(flag)}"`)
          .join(", ")}],`;
  const { services, globalOutbound, extraWorkers } = buildOutboundServices({
    allowFetch: options.allowFetch ?? false,
    allowedFetchOrigins: [...(options.allowedFetchOrigins ?? [])],
  });
  const modules = options.modules
    .map((module) => {
      const field =
        module.kind === "esModule"
          ? "esModule"
          : module.kind === "json"
            ? "json"
            : module.kind === "text"
              ? "text"
              : "wasm";
      return `    ( name = "${escapeCapnpString(module.name)}", ${field} = embed "${escapeCapnpString(module.fileName)}" ),`;
    })
    .join("\n");

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "main", worker = .mainWorker ),
    ( name = "capabilityBridge", external = ( address = "127.0.0.1:${bridgePort}", http = () ) ),
    ${services}
  ],
  sockets = [
    ( name = "http", address = "127.0.0.1:${port}", http = (), service = "main" ),
  ],
);

const mainWorker :Workerd.Worker = (
  modules = [
${modules}
  ],
  compatibilityDate = "${compatibilityDate}",${compatibilityFlags}
  bindings = [
    ( name = "CAPABILITY_BRIDGE", service = "capabilityBridge" ),
    ( name = "CAPABILITY_BRIDGE_TOKEN", text = "${escapeCapnpString(bridgeToken)}" ),
  ],
  globalOutbound = ${globalOutbound},
);
${extraWorkers}
`;
}
