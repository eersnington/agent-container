#!/usr/bin/env node

import { cwd, stderr, stdout } from "node:process";

import { createAgentContainer } from "agent-container";

function renderHelp(): string {
  return [
    "agent-container",
    "",
    "Usage:",
    "  agent-container describe",
    "  agent-container help",
  ].join("\n");
}

async function main(args: readonly string[]): Promise<number> {
  const [command] = args;

  if (command === undefined || command === "help" || command === "--help") {
    stdout.write(`${renderHelp()}\n`);
    return 0;
  }

  if (command !== "describe") {
    stderr.write(`Unknown command: ${command}\n`);
    stderr.write(`${renderHelp()}\n`);
    return 1;
  }

  const container = await createAgentContainer({
    workspace: {
      root: cwd(),
    },
  });

  stdout.write(`${JSON.stringify(container.describe(), null, 2)}\n`);
  return 0;
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
