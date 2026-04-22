import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    "workerd",
  ];

  for (const candidate of candidates) {
    if (candidate === "workerd") {
      return candidate;
    }

    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Could not find a workerd binary. Install workerd in the workspace or pass workerdBinary explicitly.",
  );
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
