#!/usr/bin/env node

import { stdout } from "node:process";

const help = [
  "agent-container",
  "",
  "This branch only establishes the package surface.",
].join("\n");

stdout.write(`${help}\n`);
