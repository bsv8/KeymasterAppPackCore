import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ERROR_CODES, KeymasterError, throwIfAborted } from "./errors.js";
import { jcs } from "./jcs.js";
import { extractIdentityProof } from "./html.js";
import {
  assertManifestIdentity,
  manifestIdentityProof,
  validateManifest,
  verifyBundleSignature,
} from "./manifest.js";
import { contentTypeForLogicalPath } from "./mime.js";
import { seedHashFile } from "./seed.js";
import { parseStrictJson } from "./strict-json.js";
import type { DeploymentRecordV1, VerifyDeploymentOptions } from "./types.js";

const DEFAULT_MANIFEST_LIMIT = 2 * 1024 * 1024;

export async function verifyDeployment(
  directory: string,
  options: VerifyDeploymentOptions = {},
): Promise<DeploymentRecordV1> {
  const signal = options.signal;
  throwIfAborted(signal);
  const manifestPath = join(directory, ".keymaster.json");
  let source: string;
  try {
    const bytes = await readFile(manifestPath);
    if (bytes.byteLength > (options.maxManifestBytes ?? DEFAULT_MANIFEST_LIMIT)) {
      throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "manifest exceeds size limit");
    }
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof KeymasterError) throw error;
    throw new KeymasterError(
      ERROR_CODES.MANIFEST_INVALID,
      "unable to read manifest",
      { path: manifestPath },
      error,
    );
  }
  const manifest = validateManifest(parseStrictJson(source));
  assertManifestIdentity(manifest);
  if (!verifyBundleSignature(manifest, options.allowUnsigned === true)) {
    throw new KeymasterError(
      ERROR_CODES.BUNDLE_SIGNATURE_INVALID,
      "bundle signature verification failed",
    );
  }

  const expectedHashes = new Set(Object.values(manifest.files));
  for (const hash of expectedHashes) {
    throwIfAborted(signal);
    const path = join(directory, hash);
    try {
      const details = await lstat(path);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error("not a regular file");
    } catch (error) {
      throw new KeymasterError(
        ERROR_CODES.ENTRY_MISSING,
        `content-addressed file is missing: ${hash}`,
        { hash },
        error,
      );
    }
    const actual = await seedHashFile(path, signal);
    if (actual !== hash)
      throw new KeymasterError(ERROR_CODES.SEED_HASH_MISMATCH, `seed hash mismatch: ${hash}`, {
        hash,
        actual,
      });
  }

  if (options.strictFiles !== false) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".keymaster.json") continue;
      if (
        !entry.isFile() ||
        !/^[0-9a-f]{64}$/.test(entry.name) ||
        !expectedHashes.has(entry.name)
      ) {
        throw new KeymasterError(
          ERROR_CODES.UNDECLARED_FILE,
          `undeclared deployment file: ${entry.name}`,
          { file: entry.name },
        );
      }
    }
  }

  const indexLogicalPaths = Object.entries(manifest.files)
    .filter(([, hash]) => hash === manifest.index)
    .map(([logicalPath]) => logicalPath)
    .sort();
  const htmlEntryPaths = indexLogicalPaths.filter(
    (logicalPath) => contentTypeForLogicalPath(logicalPath) === "text/html; charset=utf-8",
  );
  const entryPath = options.entryLogicalPath;
  if (entryPath) {
    if (manifest.files[entryPath] !== manifest.index)
      throw new KeymasterError(ERROR_CODES.ENTRY_MISSING, "manifest entry does not match index", {
        entryPath,
        indexLogicalPaths,
      });
    if (!htmlEntryPaths.includes(entryPath))
      throw new KeymasterError(ERROR_CODES.ENTRY_MISSING, "deployment entry must be HTML", {
        entryPath,
        indexLogicalPaths,
      });
  } else {
    if (htmlEntryPaths.length !== 1)
      throw new KeymasterError(
        ERROR_CODES.ENTRY_MISSING,
        "manifest index must have exactly one HTML logical entry",
        { index: manifest.index, indexLogicalPaths, htmlEntryPaths },
      );
  }
  const indexPath = join(directory, manifest.index);
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(indexPath));
  } catch (error) {
    throw new KeymasterError(
      ERROR_CODES.ENTRY_MISSING,
      "unable to read deployment entry",
      { hash: manifest.index },
      error,
    );
  }
  const embedded = extractIdentityProof(html);
  if (jcs(embedded) !== jcs(manifestIdentityProof(manifest))) {
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_EMBED_MISMATCH,
      "entry identity does not match manifest",
    );
  }

  const filesByHash: DeploymentRecordV1["filesByHash"] = {};
  for (const [logicalPath, hash] of Object.entries(manifest.files)) {
    const contentType = contentTypeForLogicalPath(logicalPath);
    const entry = filesByHash[hash];
    if (entry && entry.contentType !== contentType)
      throw new KeymasterError(
        ERROR_CODES.MIME_CONFLICT,
        `one hash maps to incompatible MIME types: ${hash}`,
        {
          hash,
          logicalPath,
          contentTypes: [entry.contentType, contentType].sort(),
          logicalPaths: [...entry.logicalPaths, logicalPath].sort(),
        },
      );
    const resolved = entry ?? { logicalPaths: [], contentType };
    resolved.logicalPaths.push(logicalPath);
    resolved.logicalPaths.sort();
    filesByHash[hash] = resolved;
  }
  return {
    version: 1,
    publisherPublicKey: manifest.publisherPublicKey,
    appId: manifest.app.id,
    appName: manifest.app.name,
    indexHash: manifest.index,
    filesByHash,
  };
}
