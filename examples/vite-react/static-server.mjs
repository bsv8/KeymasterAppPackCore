import { createServer } from "node:http";
import { rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDeployment } from "../../packages/core/dist/index.js";

export async function startDeploymentServer(
  directory,
  { prefix = "/", port = 4173, allowUnsigned = false } = {},
) {
  const root = resolve(directory);
  const record = await verifyDeployment(root, { allowUnsigned });
  const normalizedPrefix = `/${prefix.replace(/^\/+|\/+$/g, "")}/`.replace("//", "/");
  const server = createServer(async (request, response) => {
    try {
      const requestPath = new URL(request.url ?? "/", "http://keymaster.local").pathname;
      if (!requestPath.startsWith(normalizedPrefix)) {
        response.writeHead(404).end();
        return;
      }
      const relative = requestPath.slice(normalizedPrefix.length);
      const hash = relative === "" ? record.indexHash : relative;
      const file = record.filesByHash[hash];
      if (!file || !/^[0-9a-f]{64}$/.test(hash)) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": file.contentType,
        "cache-control": "public, immutable",
      });
      response.end(await readFile(join(root, hash)));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolveServer) => server.listen(port, resolveServer));
  return { server, record, prefix: normalizedPrefix };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] ?? "dist";
  const allowUnsigned = process.argv.includes("--allow-unsigned");
  const removeManifest = process.argv.includes("--remove-manifest");
  const { prefix } = await startDeploymentServer(directory, { allowUnsigned, prefix: "/fixture/" });
  if (removeManifest) await rm(join(resolve(directory), ".keymaster.json"), { force: true });
  console.log(`Deployment available at http://localhost:4173${prefix}`);
}
