import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ERROR_CODES, KeymasterError, throwIfAborted } from "./errors.js";
import { manifestJson, validateManifest } from "./manifest.js";
import { seedHashBytes } from "./seed.js";
import { validateLogicalPath } from "./path.js";
import type { BundleFileInput, KeymasterAppManifestV1 } from "./types.js";

export interface HashedBundle {
  files: Record<string, Uint8Array>;
  logicalToHash: Record<string, string>;
}

export async function hashBundleFiles(
  files: readonly BundleFileInput[],
  signal?: AbortSignal,
): Promise<HashedBundle> {
  const output: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const logicalToHash: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const file of [...files].sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))) {
    throwIfAborted(signal);
    validateLogicalPath(file.logicalPath);
    const bytes = new Uint8Array(file.bytes);
    const priorHash = logicalToHash[file.logicalPath];
    const hash = await seedHashBytes(bytes, signal);
    if (priorHash !== undefined && priorHash !== hash)
      throw new KeymasterError(
        ERROR_CODES.MANIFEST_INVALID,
        `logical path is declared more than once: ${file.logicalPath}`,
        { logicalPath: file.logicalPath },
      );
    const existing = output[hash];
    if (existing && !sameBytes(existing, bytes))
      throw new KeymasterError(ERROR_CODES.SEED_HASH_MISMATCH, "hash collision detected", { hash });
    output[hash] ??= bytes;
    logicalToHash[file.logicalPath] = hash;
  }
  return { files: output, logicalToHash };
}

export async function writeHashedBundle(
  directory: string,
  bundle: HashedBundle,
  manifest: KeymasterAppManifestV1,
  options: { replace?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const signal = options.signal;
  throwIfAborted(signal);
  validateManifest(manifest);
  const stage = `${directory}.tmp-${randomUUID()}`;
  try {
    await mkdir(stage, { recursive: true });
    for (const [hash, bytes] of Object.entries(bundle.files)) {
      throwIfAborted(signal);
      await writeFile(join(stage, hash), bytes, { flag: "wx", mode: 0o644 });
    }
    await writeFile(join(stage, ".keymaster.json"), manifestJson(manifest), {
      flag: "wx",
      mode: 0o644,
    });
    if (options.replace) {
      // Replacing a published directory is intentionally opt-in and keeps a rollback path until publish succeeds.
      const previous = `${directory}.previous-${randomUUID()}`;
      let movedPrevious = false;
      try {
        try {
          await rename(directory, previous);
          movedPrevious = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(stage, directory);
        if (movedPrevious) await rm(previous, { recursive: true, force: true });
      } catch (error) {
        try {
          if (movedPrevious) await rename(previous, directory);
        } catch {
          /* preserve primary error */
        }
        throw error;
      }
    } else {
      await rename(stage, directory);
    }
  } catch (error) {
    try {
      await rm(stage, { recursive: true, force: true });
    } catch {
      /* preserve primary error */
    }
    if (error instanceof KeymasterError) throw error;
    throw new KeymasterError(
      ERROR_CODES.ATOMIC_WRITE_FAILED,
      "unable to publish bundle atomically",
      { directory },
      error,
    );
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
