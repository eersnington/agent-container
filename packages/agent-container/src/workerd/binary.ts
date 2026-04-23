import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const workerdPathFallback = "workerd";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findWorkerdBinary(explicitPath?: string): Promise<string> {
  if (explicitPath !== undefined) {
    if (await exists(explicitPath)) {
      return explicitPath;
    }

    throw new Error(`Could not find workerd binary at ${explicitPath}.`);
  }

  const candidates = [
    join(__dirname, "..", "..", "..", "node_modules", ".bin", "workerd"),
    join(__dirname, "..", "..", "..", "node_modules", "workerd", "bin", "workerd"),
    join(process.cwd(), "node_modules", ".bin", "workerd"),
    join(process.cwd(), "node_modules", "workerd", "bin", "workerd"),
  ];

  const resolvedCandidates = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      exists: await exists(candidate),
    })),
  );

  for (const resolvedCandidate of resolvedCandidates) {
    if (resolvedCandidate.exists) {
      return resolvedCandidate.candidate;
    }
  }

  // Returning "workerd" here is intentional: `spawn("workerd", ...)` asks the OS
  // to resolve the executable from PATH when we did not find a workspace-local binary.
  return workerdPathFallback;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Failed to allocate a free port"));
        return;
      }

      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });

    server.on("error", reject);
  });
}
