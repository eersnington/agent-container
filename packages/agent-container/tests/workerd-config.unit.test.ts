import { describe, expect, it } from "vitest";

import { buildConfig } from "../src/workerd/config.js";

describe("workerd config", () => {
  it("emits explicit compatibility flags for module runs", () => {
    const config = buildConfig(1000, 1001, "token", {
      compatibilityFlags: ["nodejs_compat"],
      modules: [{ name: "worker.js", fileName: "worker.js", kind: "esModule" }],
    });

    expect(config).toContain('compatibilityFlags = ["nodejs_compat"]');
  });
});
