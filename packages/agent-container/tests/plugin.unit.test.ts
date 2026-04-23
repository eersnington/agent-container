import { describe, expect, it } from "vitest";

import { defineAgentContainerPlugin } from "agent-container";

describe("plugin defaults", () => {
  it("merges caller tool overrides without dropping default capabilities", () => {
    const plugin = defineAgentContainerPlugin({
      name: "demo",
      container: {
        workspace: {
          root: "/tmp/repo",
        },
      },
      tools: {
        bash: "EXEC.shell",
        edit: "WORKSPACE.write",
      },
    });

    expect(plugin.capabilities).toEqual(["WORKSPACE", "EXEC", "ENV", "SECRETS", "OBSERVE"]);
    expect(plugin.tools).toEqual({
      read: "WORKSPACE.read",
      write: "WORKSPACE.write",
      glob: "WORKSPACE.glob",
      grep: "WORKSPACE.grep",
      bash: "EXEC.shell",
      edit: "WORKSPACE.write",
    });
  });
});
