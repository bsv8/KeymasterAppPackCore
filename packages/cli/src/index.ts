import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  ERROR_CODES,
  KeymasterError,
  extractAppIdentityProof,
  extractAppMetadata,
  identityProofJson,
  signIdentityProof,
  manifestJson,
  parseStrictJson,
  signBundleManifest,
  validateManifest,
  verifyDeployment,
} from "@keymaster-app-pack/core";
import type { KeymasterAppManifestV1, PublisherSigner } from "@keymaster-app-pack/core";
import {
  SignerRegistry,
  createPublisherKey,
  listPublisherKeys,
  signerRegistryFromEnvironment,
} from "./signer.js";

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
      "usage: keymaster-app <app|publisher|bundle|verify|build> ...",
    );
  const action = group === "build" ? "build" : command.shift();
  const rest = command;
  if (!action)
    throw new KeymasterError(
      ERROR_CODES.MANIFEST_INVALID,
      "usage: keymaster-app <app|publisher|bundle|verify|build> ...",
    );
  if (group === "publisher") {
    if (action === "create") {
      if (rest.some((arg) => arg.startsWith("--")))
        throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "usage: keymaster-app publisher create <name>");
      const name = positional(rest, []).find((arg) => !arg.startsWith("--"));
      if (!name || positional(rest, []).filter((arg) => !arg.startsWith("--")).length !== 1)
        throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "usage: keymaster-app publisher create <name>");
      stdout(JSON.stringify(await createPublisherKey(name)));
      return 0;
    }
    if (action === "list") {
      if (rest.length !== 0)
        throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "usage: keymaster-app publisher list");
      stdout(JSON.stringify(await listPublisherKeys()));
      return 0;
    }
    throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, `unknown command: publisher ${action}`);
  }
  if (group === "app") {
    if (action !== "create" && action !== "sign")
      throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, `unknown command: app ${action}`);
    if (action === "create") {
      const { input, output, replace } = parseAppCreateArgs(rest, cwd);
      const proof = extractAppIdentityProof(await readUtf8Input(input));
      await writeProofJson(output, proof, replace);
      stdout(JSON.stringify({ input, output, proof }));
      return 0;
    }
    const { input, publisher } = parseAppSignArgs(rest, cwd);
    const metadata = extractAppMetadata(await readUtf8Input(input));
    const registry = options.signers ?? (await signerRegistryFromEnvironment(publisher));
    const proof = await signIdentityProof(registry.get(publisher), metadata);
    stdout(
      JSON.stringify({
        publisher,
        publisherPublicKey: proof.publisherPublicKey,
        signature: proof.signature,
        meta: `<meta name="keymaster-app:identity-signature" content="${proof.signature}">`,
      }),
    );
    return 0;
  }
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

interface AppCreateArgs {
  input: string;
  output: string;
  replace: boolean;
}

/** 解析 app create 的最小参数集合，未知参数必须尽早失败。 */
function parseAppCreateArgs(args: readonly string[], cwd: string): AppCreateArgs {
  let input = "index.html";
  let output = "keymaster.app.json";
  let replace = false;
  let seenInput = false;
  let seenOutput = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--replace") {
      if (replace) throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "duplicate --replace");
      replace = true;
      continue;
    }
    const match = /^(--input|--out)(?:=(.*))?$/u.exec(arg);
    if (!match) {
      throw new KeymasterError(
        ERROR_CODES.MANIFEST_INVALID,
        "usage: keymaster-app app create [--input <path>] [--out <path>] [--replace]",
      );
    }
    const name = match[1]!;
    let value = match[2];
    if (value === undefined) {
      value = args[++index];
      if (!value || value.startsWith("--"))
        throw new KeymasterError(
          ERROR_CODES.MANIFEST_INVALID,
          `${name === "--publisher" ? name + " requires a name" : name + " requires a path"}`,
        );
    }
    if (!value)
      throw new KeymasterError(
        ERROR_CODES.MANIFEST_INVALID,
        `${name === "--publisher" ? name + " requires a name" : name + " requires a path"}`,
      );
    if (name === "--input") {
      if (seenInput) throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "duplicate --input");
      seenInput = true;
      input = value;
    } else if (name === "--out") {
      if (seenOutput) throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "duplicate --out");
      seenOutput = true;
      output = value;
    }
  }
  const resolvedInput = resolve(cwd, input);
  const resolvedOutput = resolve(cwd, output);
  if (resolvedInput === resolvedOutput)
    throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "input and output paths must differ");
  return { input: resolvedInput, output: resolvedOutput, replace };
}

interface AppSignArgs {
  input: string;
  publisher: string;
}

function parseAppSignArgs(args: readonly string[], cwd: string): AppSignArgs {
  let input = "index.html";
  let publisher: string | undefined;
  let seenInput = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const match = /^(--input|--publisher)(?:=(.*))?$/u.exec(arg);
    if (!match)
      throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "usage: keymaster-app app sign --publisher <name> [--input <path>]");
    let value = match[2] ?? args[++index];
    if (!value || value.startsWith("--"))
      throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, `${match[1] === "--publisher" ? "--publisher requires a name" : "--input requires a path"}`);
    if (match[1] === "--input") {
      if (seenInput) throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "duplicate --input");
      seenInput = true;
      input = value;
    } else {
      if (publisher !== undefined) throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "duplicate --publisher");
      publisher = value;
    }
  }
  if (!publisher) throw new KeymasterError(ERROR_CODES.SIGNER_UNAVAILABLE, "--publisher signer alias is required");
  return { input: resolve(cwd, input), publisher };
}

async function readUtf8Input(path: string): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch (error) {
    if (error instanceof KeymasterError) throw error;
    throw new KeymasterError(ERROR_CODES.METADATA_INVALID, "unable to read input HTML", { path }, error);
  }
}

/** 以同目录临时文件原子写入项目根 flat proof JSON。 */
async function writeProofJson(
  output: string,
  proof: Parameters<typeof identityProofJson>[0],
  replace: boolean,
): Promise<void> {
  const stage = `${output}.tmp-${randomUUID()}`;
  try {
    await writeFile(stage, identityProofJson(proof), { flag: "wx", mode: 0o644 });
    if (!replace) {
      await link(stage, output);
      await rm(stage, { force: true });
    }
    else await rename(stage, output);
  } catch (error) {
    await rm(stage, { force: true }).catch(() => undefined);
    if (error instanceof KeymasterError) throw error;
    throw new KeymasterError(ERROR_CODES.ATOMIC_WRITE_FAILED, "unable to write app metadata atomically", { output }, error);
  }
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
