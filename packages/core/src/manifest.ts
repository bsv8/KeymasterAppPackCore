import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ERROR_CODES, KeymasterError } from "./errors.js";
import { hexToBytes, isLowerHex } from "./encoding.js";
import { validateIdentityPayload, verifyIdentityProof } from "./identity.js";
import { jcs, jcsBytes } from "./jcs.js";
import { validateLogicalPath } from "./path.js";
import type {
  AppIdentityProofV1,
  BundleSigningPayloadV1,
  KeymasterAppManifestV1,
  PublisherSigner,
} from "./types.js";

const BUNDLE_DOMAIN = new TextEncoder().encode("keymaster-app-bundle:v1");

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateManifest(value: unknown): KeymasterAppManifestV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "manifest must be an object");
  }
  const object = value as Record<string, unknown>;
  if (
    !exactKeys(object, [
      "version",
      "publisherPublicKey",
      "app",
      "identitySignature",
      "index",
      "files",
      "bundleSignature",
    ])
  ) {
    throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "manifest has unexpected fields");
  }
  const identity = validateIdentityPayload({
    version: object.version,
    publisherPublicKey: object.publisherPublicKey,
    app: object.app,
  });
  if (
    !isLowerHex(object.identitySignature, 64) ||
    !isLowerHex(object.index, 32) ||
    (object.bundleSignature !== "" && !isLowerHex(object.bundleSignature, 64))
  ) {
    throw new KeymasterError(
      ERROR_CODES.MANIFEST_INVALID,
      "manifest contains invalid hash or signature encoding",
    );
  }
  if (object.files === null || typeof object.files !== "object" || Array.isArray(object.files)) {
    throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "manifest files must be a dictionary");
  }
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [logicalPath, hash] of Object.entries(object.files as Record<string, unknown>)) {
    validateLogicalPath(logicalPath);
    if (!isLowerHex(hash, 32))
      throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "manifest file hash is invalid", {
        logicalPath,
      });
    files[logicalPath] = hash;
  }
  if (Object.keys(files).length === 0)
    throw new KeymasterError(ERROR_CODES.MANIFEST_INVALID, "manifest files must not be empty");
  if (!Object.values(files).includes(object.index as string)) {
    throw new KeymasterError(ERROR_CODES.ENTRY_MISSING, "manifest index is not present in files");
  }
  return {
    ...identity,
    identitySignature: object.identitySignature,
    index: object.index,
    files,
    bundleSignature: object.bundleSignature,
  };
}

export function manifestIdentityProof(manifest: KeymasterAppManifestV1): AppIdentityProofV1 {
  const value = validateManifest(manifest);
  return {
    version: 1,
    publisherPublicKey: value.publisherPublicKey,
    app: value.app,
    signature: value.identitySignature,
  };
}

export function assertManifestIdentity(manifest: KeymasterAppManifestV1): void {
  const proof = manifestIdentityProof(manifest);
  if (!verifyIdentityProof(proof))
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_SIGNATURE_INVALID,
      "manifest identity signature verification failed",
    );
}

export function bundleSigningPayload(manifest: KeymasterAppManifestV1): BundleSigningPayloadV1 {
  const value = validateManifest(manifest);
  return {
    version: value.version,
    publisherPublicKey: value.publisherPublicKey,
    app: value.app,
    identitySignature: value.identitySignature,
    index: value.index,
    files: value.files,
  };
}

export function bundleSigningBytes(manifest: KeymasterAppManifestV1): Uint8Array {
  return new Uint8Array([...BUNDLE_DOMAIN, 0, ...jcsBytes(bundleSigningPayload(manifest))]);
}

export function bundleSigningDigest(manifest: KeymasterAppManifestV1): Uint8Array {
  return sha256(bundleSigningBytes(manifest));
}

export function manifestJson(manifest: KeymasterAppManifestV1): string {
  return `${jcs(validateManifest(manifest))}\n`;
}

export async function signBundleManifest(
  signer: PublisherSigner,
  manifest: KeymasterAppManifestV1,
): Promise<KeymasterAppManifestV1> {
  const value = validateManifest(manifest);
  assertManifestIdentity(value);
  const publicKey = await signer.getPublicKey();
  if (publicKey !== value.publisherPublicKey)
    throw new KeymasterError(
      ERROR_CODES.PUBLISHER_KEY_MISMATCH,
      "signer public key does not match manifest",
    );
  const signature = await signer.signDigest(bundleSigningDigest(value));
  if (signature.length !== 64)
    throw new KeymasterError(
      ERROR_CODES.BUNDLE_SIGNATURE_INVALID,
      "signer returned a non-compact signature",
    );
  const signed = validateManifest({
    ...value,
    bundleSignature: [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  });
  if (!verifyBundleSignature(signed))
    throw new KeymasterError(
      ERROR_CODES.BUNDLE_SIGNATURE_INVALID,
      "signer returned an invalid bundle signature",
    );
  return signed;
}

export function verifyBundleSignature(
  manifest: KeymasterAppManifestV1,
  allowUnsigned = false,
): boolean {
  const value = validateManifest(manifest);
  assertManifestIdentity(value);
  if (value.bundleSignature === "") return allowUnsigned;
  try {
    const proof = manifestIdentityProof(value);
    return secpVerify(value.bundleSignature, bundleSigningDigest(value), proof.publisherPublicKey);
  } catch {
    return false;
  }
}

function secpVerify(signature: string, digest: Uint8Array, publicKey: string): boolean {
  return secp256k1.verify(
    hexToBytes(signature, 64, "bundle signature"),
    digest,
    hexToBytes(publicKey, 33, "publisher public key"),
    { prehash: false },
  );
}
