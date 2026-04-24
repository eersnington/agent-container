import { describe, expect, it } from "vitest";

import { buildConfig } from "../src/workerd/config.js";

describe("workerd config", () => {
  it("emits compatibility flags and native module kinds", () => {
    const config = buildConfig(1000, 1001, "token", {
      compatibilityFlags: ["nodejs_compat"],
      modules: [
        { name: "worker.js", fileName: "worker.js", kind: "esModule" },
        { name: "data.json", fileName: "data.json", kind: "json" },
        { name: "message.txt", fileName: "message.txt", kind: "text" },
        { name: "add.wasm", fileName: "add.wasm", kind: "wasm" },
      ],
    });

    expect(config).toContain('compatibilityFlags = ["nodejs_compat"]');
    expect(config).toContain('( name = "worker.js", esModule = embed "worker.js" )');
    expect(config).toContain('( name = "data.json", json = embed "data.json" )');
    expect(config).toContain('( name = "message.txt", text = embed "message.txt" )');
    expect(config).toContain('( name = "add.wasm", wasm = embed "add.wasm" )');
  });
});
