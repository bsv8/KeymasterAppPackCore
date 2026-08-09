import { mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { init, parse } from "es-module-lexer";
import type { Plugin, ResolvedConfig } from "vite";
import {
  ERROR_CODES,
  KeymasterError,
  assertIdentityProof,
  createBundleGraph,
  extractCssReferences,
  extractHtmlReferences,
  injectIdentityMeta,
  jcs,
  manifestJson,
  parseStrictJson,
  relativeLogicalPath,
  replaceCssReferences,
  replaceHtmlReferences,
  resolveRelativeLogicalPath,
  seedHashBytes,
  stableDependencyOrder,
  validateIdentityProof,
  validateLogicalPath,
} from "@keymaster-app-pack/core";
import type { AppIdentityProofV1, KeymasterAppManifestV1 } from "@keymaster-app-pack/core";

export interface KeymasterViteOptions {
  identity: AppIdentityProofV1 | string;
  entryLogicalPath?: string;
  strictExternal?: boolean;
  includeSourceMaps?: boolean;
  atomicOutput?: boolean;
  replaceExisting?: boolean;
}

interface BundleNode {
  logicalPath: string;
  bytes: Uint8Array;
  kind: "asset" | "chunk";
  dependencies: Set<string>;
  chunk?: OutputChunk;
}

interface WarnContext {
  warn(message: string): void;
}

interface OutputAsset {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}

interface OutputChunk {
  type: "chunk";
  fileName: string;
  code: string;
  imports: string[];
  dynamicImports: string[];
  referencedFiles?: string[];
}

type OutputBundle = Record<string, OutputAsset | OutputChunk>;

export function keymasterVite(options: KeymasterViteOptions): Plugin {
  const entryLogicalPath = options.entryLogicalPath ?? "index.html";
  let resolvedConfig: ResolvedConfig | undefined;
  let identityPromise: Promise<AppIdentityProofV1> | undefined;
  let targetOutDir: string | undefined;
  let stagingOutDir: string | undefined;
  let buildFailed = false;
  let outputWritten = false;

  const cleanupStaging = async (pendingStaging: string | undefined): Promise<void> => {
    if (!pendingStaging) return;
    try {
      await rm(pendingStaging, { recursive: true, force: true });
    } catch {
      // Preserve the original build or publish error.
    } finally {
      if (stagingOutDir === pendingStaging) stagingOutDir = undefined;
    }
  };

  const finalizer: Plugin = {
    name: "keymaster-app-pack:finalizer",
    enforce: "post",
    writeBundle() {
      outputWritten = true;
    },
    closeBundle: {
      order: "post",
      handler: async () => {
        const pendingStaging = stagingOutDir;
        if (!pendingStaging) return;
        try {
          if (!outputWritten || buildFailed) return;
          if (targetOutDir)
            await publishStagingDirectory(
              pendingStaging,
              targetOutDir,
              options.replaceExisting === true,
            );
        } finally {
          await cleanupStaging(pendingStaging);
        }
      },
    },
  };

  const loadIdentity = async (): Promise<AppIdentityProofV1> => {
    if (!identityPromise) {
      identityPromise =
        typeof options.identity === "string"
          ? import("node:fs/promises")
              .then(({ readFile }) => readFile(options.identity as string, "utf8"))
              .then(parseStrictJson)
              .then(validateIdentityProof)
          : Promise.resolve(validateIdentityProof(options.identity));
    }
    const identity = await identityPromise;
    assertIdentityProof(identity);
    return identity;
  };

  return {
    name: "keymaster-app-pack",
    enforce: "post",
    config(config, env) {
      if (
        env.command !== "build" ||
        options.atomicOutput === false ||
        config.build?.write === false
      )
        return;
      targetOutDir = resolve(config.root ?? process.cwd(), config.build?.outDir ?? "dist");
      stagingOutDir = `${targetOutDir}.tmp-${randomUUID()}`;
      outputWritten = false;
      return { build: { outDir: stagingOutDir, emptyOutDir: true } };
    },
    configResolved(config) {
      resolvedConfig = config;
      const plugins = config.plugins as Plugin[];
      if (stagingOutDir) {
        const protectedPlugins = plugins.map((plugin) =>
          protectOutputHooks(plugin, () => cleanupStaging(stagingOutDir)),
        );
        plugins.splice(0, plugins.length, ...protectedPlugins);
        if (!plugins.includes(finalizer)) plugins.push(finalizer);
      }
      if (config.build.sourcemap && !options.includeSourceMaps) {
        throw new KeymasterError(
          ERROR_CODES.REFERENCE_UNSUPPORTED,
          "V1 requires source maps to be explicitly included",
        );
      }
    },
    async buildEnd(error) {
      if (error && stagingOutDir) {
        buildFailed = true;
        await rm(stagingOutDir, { recursive: true, force: true });
      }
    },
    async transformIndexHtml(html) {
      return injectIdentityMeta(html, await loadIdentity());
    },
    async generateBundle(_outputOptions, bundle) {
      const identity = await loadIdentity();
      await init;
      const outputBundle = bundle as unknown as OutputBundle;
      const warnedMessages = new Set<string>();
      const context: WarnContext = {
        warn: (message) => {
          if (warnedMessages.has(message)) return;
          warnedMessages.add(message);
          this.warn(message);
        },
      };
      const nodes = collectNodes(outputBundle, options, context);
      const dependencies = new Map<string, Iterable<string>>();
      for (const node of nodes.values()) dependencies.set(node.logicalPath, node.dependencies);
      const graph = createBundleGraph(dependencies);
      const order = stableDependencyOrder(graph);
      const hashes = new Map<string, string>();
      const transformed = new Map<string, Uint8Array>();
      for (const logicalPath of order) {
        const node = nodes.get(logicalPath)!;
        let bytes = node.bytes;
        if (node.kind === "asset" && logicalPath.toLowerCase().endsWith(".html")) {
          const replacements = new Map<string, string>();
          for (const dependency of node.dependencies)
            replacements.set(dependency, relativeLogicalPath(logicalPath, hashes.get(dependency)!));
          bytes = new TextEncoder()
            .encode(
              replaceHtmlReferences(new TextDecoder().decode(bytes), replacements, (reference) =>
                resolveReference(logicalPath, reference, nodes, options, context),
              ),
            )
            .slice();
        } else if (node.kind === "asset" && logicalPath.toLowerCase().endsWith(".css")) {
          const replacements = new Map<string, string>();
          for (const dependency of node.dependencies)
            replacements.set(dependency, relativeLogicalPath(logicalPath, hashes.get(dependency)!));
          bytes = new TextEncoder()
            .encode(
              replaceCssReferences(new TextDecoder().decode(bytes), replacements, (reference) =>
                resolveReference(logicalPath, reference, nodes, options, context),
              ),
            )
            .slice();
        } else if (node.kind === "chunk") {
          bytes = rewriteChunk(node, hashes, nodes, options, context);
        }
        const hash = await seedHashBytes(bytes);
        transformed.set(logicalPath, bytes);
        hashes.set(logicalPath, hash);
      }
      const entryHash = hashes.get(entryLogicalPath);
      if (!entryHash)
        throw new KeymasterError(
          ERROR_CODES.ENTRY_MISSING,
          `entry not found: ${entryLogicalPath}`,
          { entryLogicalPath },
        );
      const files = Object.fromEntries(
        [...hashes.entries()].sort(([a], [b]) => a.localeCompare(b)),
      );
      const manifest: KeymasterAppManifestV1 = {
        version: 1,
        publisherPublicKey: identity.publisherPublicKey,
        app: identity.app,
        identitySignature: identity.signature,
        index: entryHash,
        files,
        bundleSignature: "",
      };
      for (const key of Object.keys(outputBundle)) delete outputBundle[key];
      const physical = new Map<string, Uint8Array>();
      for (const [logicalPath, hash] of hashes) physical.set(hash, transformed.get(logicalPath)!);
      for (const [hash, source] of physical)
        this.emitFile({ type: "asset", fileName: hash, source });
      this.emitFile({ type: "asset", fileName: ".keymaster.json", source: manifestJson(manifest) });
      if (resolvedConfig?.command === "build" && resolvedConfig.build.write === false)
        this.warn("Keymaster manifest generated in bundle preview mode");
    },
  };
}

function collectNodes(
  bundle: OutputBundle,
  options: KeymasterViteOptions,
  context: WarnContext,
): Map<string, BundleNode> {
  const nodes = new Map<string, BundleNode>();
  for (const [fileName, output] of Object.entries(bundle)) {
    validateLogicalPath(fileName);
    if (fileName.endsWith(".map") && !options.includeSourceMaps)
      throw new KeymasterError(
        ERROR_CODES.REFERENCE_UNSUPPORTED,
        `source map is not included: ${fileName}`,
      );
    if (output.type === "asset") {
      const bytes =
        typeof output.source === "string"
          ? new TextEncoder().encode(output.source)
          : new Uint8Array(output.source);
      nodes.set(fileName, { logicalPath: fileName, bytes, kind: "asset", dependencies: new Set() });
    } else {
      const bytes = new TextEncoder().encode(output.code);
      nodes.set(fileName, {
        logicalPath: fileName,
        bytes,
        kind: "chunk",
        dependencies: new Set(),
        chunk: output,
      });
    }
  }
  for (const node of nodes.values()) {
    if (node.kind === "asset") {
      const content = new TextDecoder().decode(node.bytes);
      const references = node.logicalPath.toLowerCase().endsWith(".html")
        ? extractHtmlReferences(content)
        : node.logicalPath.toLowerCase().endsWith(".css")
          ? extractCssReferences(content)
          : [];
      for (const reference of references)
        addReferenceToSet(node.dependencies, node.logicalPath, reference, nodes, options, context);
    } else {
      for (const reference of [
        ...node.chunk!.imports,
        ...node.chunk!.dynamicImports,
        ...(node.chunk!.referencedFiles ?? []),
      ])
        addReferenceToSet(node.dependencies, node.logicalPath, reference, nodes, options, context);
      const code = new TextDecoder().decode(node.bytes);
      if (options.includeSourceMaps) {
        for (const reference of sourceMapReferences(code))
          addReferenceToSet(
            node.dependencies,
            node.logicalPath,
            reference.value,
            nodes,
            options,
            context,
          );
      }
      for (const record of parse(code)[0]) {
        if (record.d !== -2 && record.s >= 0 && record.e >= 0)
          addReferenceToSet(
            node.dependencies,
            node.logicalPath,
            moduleReference(code, record),
            nodes,
            options,
            context,
          );
      }
    }
  }
  return nodes;
}

function addReferenceToSet(
  dependencies: Set<string>,
  from: string,
  reference: string,
  nodes: Map<string, BundleNode>,
  options: KeymasterViteOptions,
  context: WarnContext,
): void {
  const target = resolveReference(from, reference, nodes, options, context);
  if (target) dependencies.add(target);
}

function resolveReference(
  from: string,
  reference: string,
  nodes: ReadonlyMap<string, BundleNode>,
  options: KeymasterViteOptions,
  context: WarnContext,
): string | undefined {
  if (/^(?:https?:|data:|blob:|mailto:|#)/i.test(reference)) {
    if (options.strictExternal && !/^#/u.test(reference))
      throw new KeymasterError(
        ERROR_CODES.REFERENCE_UNSUPPORTED,
        `external reference is not allowed: ${reference}`,
      );
    context.warn(`external reference is not content-addressed: ${reference}`);
    return undefined;
  }
  if (reference.includes("?"))
    throw new KeymasterError(
      ERROR_CODES.REFERENCE_UNSUPPORTED,
      `local query is unsupported: ${reference}`,
    );
  const pathPart = reference.split("#", 1)[0]!;
  const target = nodes.has(pathPart)
    ? pathPart
    : (resolveRelativeLogicalPath(from, pathPart) ??
      (pathPart.startsWith("/") ? pathPart.slice(1) : undefined));
  if (!target || !nodes.has(target))
    throw new KeymasterError(
      ERROR_CODES.REFERENCE_MISSING,
      `${from} references missing ${reference}`,
      { from, reference, target, available: [...nodes.keys()].sort() },
    );
  return target;
}

function rewriteChunk(
  node: BundleNode,
  hashes: ReadonlyMap<string, string>,
  nodes: ReadonlyMap<string, BundleNode>,
  options: KeymasterViteOptions,
  context: WarnContext,
): Uint8Array {
  const code = new TextDecoder().decode(node.bytes);
  const changes: Array<{ start: number; end: number; value: string }> = [];
  for (const record of parse(code)[0]) {
    if (record.d === -2 || record.s < 0 || record.e < 0) continue;
    const rawReference = code.slice(record.s, record.e);
    const reference = moduleReference(code, record);
    const target = resolveReference(node.logicalPath, reference, nodes, options, context);
    if (!target) continue;
    const hash = hashes.get(target);
    if (!hash)
      throw new KeymasterError(
        ERROR_CODES.REFERENCE_MISSING,
        `chunk dependency was not processed: ${target}`,
      );
    const quote =
      rawReference[0] === '"' || rawReference[0] === "'" || rawReference[0] === "`"
        ? rawReference[0]
        : "";
    changes.push({
      start: record.s,
      end: record.e,
      value: `${quote}${relativeLogicalPath(node.logicalPath, hash)}${quote}`,
    });
  }
  for (const reference of node.chunk?.referencedFiles ?? []) {
    const target = resolveReference(node.logicalPath, reference, nodes, options, context);
    if (!target) continue;
    const hash = hashes.get(target);
    if (!hash)
      throw new KeymasterError(
        ERROR_CODES.REFERENCE_MISSING,
        `chunk asset was not processed: ${target}`,
      );
    const relative = relativeLogicalPath(node.logicalPath, hash);
    const pattern = new RegExp(
      `(new\\s+URL\\(\\s*["'])${escapeRegExp(reference)}(["']\\s*,\\s*import\\.meta\\.url)`,
      "g",
    );
    for (const match of code.matchAll(pattern)) {
      const start = match.index! + match[1]!.length;
      changes.push({ start, end: start + reference.length, value: relative });
    }
  }
  if (options.includeSourceMaps) {
    for (const reference of sourceMapReferences(code)) {
      const target = resolveReference(node.logicalPath, reference.value, nodes, options, context);
      if (!target) continue;
      const hash = hashes.get(target);
      if (!hash)
        throw new KeymasterError(
          ERROR_CODES.REFERENCE_MISSING,
          `chunk source map was not processed: ${target}`,
        );
      changes.push({
        start: reference.start,
        end: reference.end,
        value: relativeLogicalPath(node.logicalPath, hash),
      });
    }
  }
  let output = code;
  for (const change of changes.sort((a, b) => b.start - a.start))
    output = `${output.slice(0, change.start)}${change.value}${output.slice(change.end)}`;
  return new TextEncoder().encode(output);
}

interface SourceMapReference {
  start: number;
  end: number;
  value: string;
}

function sourceMapReferences(source: string): SourceMapReference[] {
  const result: SourceMapReference[] = [];
  const patterns = [
    /\/\/[#@]\s*sourceMappingURL=([^\s]+)/gu,
    /\/\*[#@]\s*sourceMappingURL=([^*\s]+)\s*\*\//gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (!value || match.index === undefined) continue;
      const start = match.index + match[0].indexOf(value);
      result.push({ start, end: start + value.length, value });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}

type GenericOutputHook = (this: unknown, ...args: unknown[]) => unknown;

function protectOutputHooks(plugin: Plugin, cleanup: () => Promise<void>): Plugin {
  const protectedPlugin = { ...plugin } as Record<string, unknown>;
  for (const hookName of ["writeBundle", "closeBundle"] as const) {
    const hook = protectedPlugin[hookName];
    if (typeof hook === "function") {
      protectedPlugin[hookName] = protectOutputHook(hook as GenericOutputHook, cleanup);
    } else if (hook && typeof hook === "object" && "handler" in hook) {
      const hookObject = { ...(hook as Record<string, unknown>) };
      if (typeof hookObject.handler === "function")
        hookObject.handler = protectOutputHook(hookObject.handler as GenericOutputHook, cleanup);
      protectedPlugin[hookName] = hookObject;
    }
  }
  return protectedPlugin as unknown as Plugin;
}

function protectOutputHook(
  hook: GenericOutputHook,
  cleanup: () => Promise<void>,
): GenericOutputHook {
  return async function (this: unknown, ...args: unknown[]) {
    try {
      return await Reflect.apply(hook, this, args);
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
}

async function publishStagingDirectory(
  staging: string,
  target: string,
  replaceExisting: boolean,
): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  let previous: string | undefined;
  try {
    await stat(target);
    if (!replaceExisting)
      throw new KeymasterError(
        ERROR_CODES.ATOMIC_WRITE_FAILED,
        `target exists; set replaceExisting: true to publish: ${target}`,
        { target },
      );
    previous = `${target}.previous-${randomUUID()}`;
    await rename(target, previous);
  } catch (error) {
    if (error instanceof KeymasterError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new KeymasterError(
        ERROR_CODES.ATOMIC_WRITE_FAILED,
        "unable to prepare atomic Vite output replacement",
        { target, staging },
        error,
      );
    }
  }
  try {
    await rename(staging, target);
    if (previous) await rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (previous) {
      try {
        await rename(previous, target);
      } catch {
        // Preserve the original publish error; the recovery failure is reflected by the state on disk.
      }
    }
    throw new KeymasterError(
      ERROR_CODES.ATOMIC_WRITE_FAILED,
      "unable to atomically publish Vite output",
      { target, staging },
      error,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moduleReference(code: string, record: { s: number; e: number }): string {
  const raw = code.slice(record.s, record.e);
  if (
    raw.length >= 2 &&
    (raw[0] === '"' || raw[0] === "'" || raw[0] === "`") &&
    raw[raw.length - 1] === raw[0]
  ) {
    const reference = raw.slice(1, -1);
    if (reference.includes("${"))
      throw new KeymasterError(
        ERROR_CODES.REFERENCE_UNSUPPORTED,
        `dynamic module path is unsupported: ${raw}`,
      );
    return reference;
  }
  return raw;
}

export default keymasterVite;
