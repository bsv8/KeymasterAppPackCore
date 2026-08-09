import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ERROR_CODES,
  KeymasterError,
  manifestJson,
  parseStrictJson,
  signBundleManifest,
  signIdentityProof,
  validateIdentityPayload,
  validateManifest,
  verifyDeployment,
} from "@keymaster-app-pack/core";
import type { KeymasterAppManifestV1, PublisherSigner } from "@keymaster-app-pack/core";
import { SignerRegistry, signerRegistryFromEnvironment } from "./signer.js";

export * from "./signer.js";

const execFileAsync = promisify(execFile);

export interface CliOptions {
  cwd?: string;
  signers?: SignerRegistry;
  stdout?: (line: string) => void;
}

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (argv.some((arg) => arg === "--private-key" || arg.startsWith("--private-key=")))
    throw new KeymasterError(
      ERROR_CODES.SIGNER_UNAVAILABLE,
      "private keys must not be supplied as command-line arguments",
    );
  const [group, ...command] = argv;
  if (!group)
    throw new KeymasterError(
      ERROR_CODES.MANIFEST_INVALID,
      "usage: keymaster-app <identity|bundle|verify|build> ...",
    );
  const action = group === "build" ? "build" : command.shift();
  const rest = command;
  if (!action)
    throw new KeymasterError(
      ERROR_CODES.MANIFEST_INVALID,
      "usage: keymaster-app <identity|bundle|verify|build> ...",
    );
  if (group === "verify") {
    const directory = resolve(cwd, action);
    stdout(JSON.stringify(await verifyDeployment(directory)));
    return 0;
  }
  const alias = flag(rest, "--key");
  if (!alias)
    throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "--key signer alias is required");
  const registry = options.signers ?? (await signerRegistryFromEnvironment(alias));
  const signer = registry.get(alias);
  if (group === "identity" && action === "sign") {
    const configPath = resolve(cwd, flag(rest, "--config") ?? "keymaster.identity.json");
    const config = parseStrictJson(await readFile(configPath, "utf8"));
    const object = config as Record<string, unknown>;
    const payload = validateIdentityPayload({
      version: object.version,
      publisherPublicKey: object.publisherPublicKey,
      app: object.app,
    });
    if (payload.publisherPublicKey !== (await signer.getPublicKey()))
      throw new KeymasterError(
        ERROR_CODES.PUBLISHER_KEY_MISMATCH,
        "signer public key does not match identity config",
      );
    const proof = await signIdentityProof(signer, payload);
    await atomicWrite(configPath, `${JSON.stringify(proof)}\n`);
    stdout(configPath);
    return 0;
  }
  if (group === "bundle" && action === "sign") {
    const manifestPath = resolve(
      cwd,
      positional(rest, ["--key"]).find((arg) => !arg.startsWith("--")) ?? "dist/.keymaster.json",
    );
    const directory = dirname(manifestPath);
    const manifest = validateManifest(parseStrictJson(await readFile(manifestPath, "utf8")));
    await verifyDeployment(directory, { allowUnsigned: true });
    const signed = await signBundleManifest(signer, manifest);
    await atomicWrite(manifestPath, manifestJson(signed));
    stdout(manifestPath);
    return 0;
  }
  if (group === "build") {
    const separator = rest.indexOf("--");
    const inputArgs = separator >= 0 ? rest.slice(separator + 1) : [];
    const outDir = flag(inputArgs, "--outDir") ?? "dist";
    const target = resolve(cwd, outDir);
    const stage = `${target}.tmp-${randomUUID()}`;
    const viteArgs = withoutFlag(withoutFlag(inputArgs, "--outDir"), "--replace");
    try {
      await execFileAsync(viteCommand(cwd), ["build", ...viteArgs, "--outDir", stage], {
        cwd,
        env: process.env,
      });
      const manifestPath = resolve(stage, ".keymaster.json");
      const manifest = validateManifest(parseStrictJson(await readFile(manifestPath, "utf8")));
      await verifyDeployment(stage, { allowUnsigned: true });
      await atomicWrite(manifestPath, manifestJson(await signBundleManifest(signer, manifest)));
      await verifyDeployment(stage);
      await publishStagingDirectory(stage, target, rest.includes("--replace"));
      stdout(target);
    } catch (error) {
      try {
        await rm(stage, { recursive: true, force: true });
      } catch {
        /* preserve primary error */
      }
      throw error;
    }
    return 0;
  }
  throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, `unknown command: ${group} ${action}`);
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function withoutFlag(args: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    if (args[index]?.startsWith(`${name}=`)) continue;
    result.push(args[index]!);
  }
  return result;
}

function positional(args: readonly string[], valueFlags: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (valueFlags.includes(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    values.push(value);
  }
  return values;
}

function viteCommand(cwd: string): string {
  const local = resolve(
    cwd,
    "node_modules/.bin",
    process.platform === "win32" ? "vite.cmd" : "vite",
  );
  return local;
}

async function publishStagingDirectory(
  stage: string,
  target: string,
  replace: boolean,
): Promise<void> {
  let targetExists = false;
  try {
    await stat(target);
    targetExists = true;
    if (!replace)
      throw new KeymasterError(
        ERROR_CODES.ATOMIC_WRITE_FAILED,
        `target exists; pass --replace to publish: ${target}`,
        { target },
      );
  } catch (error) {
    if (error instanceof KeymasterError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (replace && targetExists) {
    const previous = `${target}.previous-${randomUUID()}`;
    try {
      await rename(target, previous);
      await rename(stage, target);
      await rm(previous, { recursive: true, force: true });
    } catch (error) {
      try {
        await rename(previous, target);
      } catch {
        /* preserve primary error */
      }
      throw new KeymasterError(
        ERROR_CODES.ATOMIC_WRITE_FAILED,
        "unable to atomically replace deployment",
        { target },
        error,
      );
    }
  } else {
    await rename(stage, target);
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      /* preserve primary error */
    }
    throw new KeymasterError(
      ERROR_CODES.ATOMIC_WRITE_FAILED,
      "atomic file replacement failed",
      { path },
      error,
    );
  }
}
