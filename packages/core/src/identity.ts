import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ERROR_CODES, KeymasterError } from "./errors.js";
import {
  bytesToHex,
  decodeBase64Url,
  encodeBase64Url,
  hexToBytes,
  isLowerHex,
} from "./encoding.js";
import { jcs, jcsBytes, parseStrictJcs } from "./jcs.js";
import type { AppIdentityPayloadV1, AppIdentityProofV1, PublisherSigner } from "./types.js";

const IDENTITY_DOMAIN = new TextEncoder().encode("keymaster-app-identity:v1");
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

export function validateIdentityPayload(value: unknown): AppIdentityPayloadV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity payload must be an object");
  }
  const object = value as Record<string, unknown>;
  if (!exactKeys(object, ["version", "publisherPublicKey", "app"])) {
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_INVALID,
      "identity payload has unexpected fields",
    );
  }
  if (
    object.version !== 1 ||
    typeof object.publisherPublicKey !== "string" ||
    !isLowerHex(object.publisherPublicKey, 33) ||
    !/^(02|03)/.test(object.publisherPublicKey)
  ) {
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_INVALID,
      "invalid compressed publisher public key",
    );
  }
  if (object.app === null || typeof object.app !== "object" || Array.isArray(object.app)) {
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity app must be an object");
  }
  const app = object.app as Record<string, unknown>;
  if (!exactKeys(app, ["id", "name"]) || typeof app.id !== "string" || !ID_PATTERN.test(app.id)) {
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "invalid app id");
  }
  if (
    typeof app.name !== "string" ||
    app.name.trim() === "" ||
    [...app.name].length > 120 ||
    [...app.name].some((char) => /[\u0000-\u001f\u007f-\u009f]/u.test(char))
  ) {
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "invalid app name");
  }
  return {
    version: 1,
    publisherPublicKey: object.publisherPublicKey,
    app: { id: app.id, name: app.name },
  };
}

export function validateIdentityProof(value: unknown): AppIdentityProofV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity proof must be an object");
  }
  const object = value as Record<string, unknown>;
  if (!exactKeys(object, ["version", "publisherPublicKey", "app", "signature"])) {
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity proof has unexpected fields");
  }
  const payload = validateIdentityPayload({
    version: object.version,
    publisherPublicKey: object.publisherPublicKey,
    app: object.app,
  });
  if (!isLowerHex(object.signature, 64)) {
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_INVALID,
      "identity signature must be 64-byte lowercase hex",
    );
  }
  return { ...payload, signature: object.signature };
}

export function identitySigningBytes(payload: AppIdentityPayloadV1): Uint8Array {
  validateIdentityPayload(payload);
  return new Uint8Array([...IDENTITY_DOMAIN, 0, ...jcsBytes(payload)]);
}

export function identitySigningDigest(payload: AppIdentityPayloadV1): Uint8Array {
  return sha256(identitySigningBytes(payload));
}

export async function signIdentityProof(
  signer: PublisherSigner,
  payload: Omit<AppIdentityPayloadV1, "publisherPublicKey"> & { publisherPublicKey?: string },
): Promise<AppIdentityProofV1> {
  const publisherPublicKey = await signer.getPublicKey();
  const complete = validateIdentityPayload({ ...payload, publisherPublicKey });
  const signature = await signer.signDigest(identitySigningDigest(complete));
  if (signature.length !== 64)
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_INVALID,
      "signer returned a non-compact signature",
    );
  const proof = validateIdentityProof({ ...complete, signature: bytesToHex(signature) });
  assertIdentityProof(proof);
  return proof;
}

export function verifyIdentityProof(proof: AppIdentityProofV1): boolean {
  const validated = validateIdentityProof(proof);
  try {
    const payload: AppIdentityPayloadV1 = {
      version: validated.version,
      publisherPublicKey: validated.publisherPublicKey,
      app: validated.app,
    };
    return secp256k1.verify(
      hexToBytes(validated.signature, 64, "identity signature"),
      identitySigningDigest(payload),
      hexToBytes(validated.publisherPublicKey, 33, "publisher public key"),
      { prehash: false },
    );
  } catch {
    return false;
  }
}

export function assertIdentityProof(proof: AppIdentityProofV1): void {
  if (!verifyIdentityProof(proof))
    throw new KeymasterError(
      ERROR_CODES.IDENTITY_SIGNATURE_INVALID,
      "identity signature verification failed",
    );
}

export function encodeIdentityProof(proof: AppIdentityProofV1): string {
  validateIdentityProof(proof);
  return encodeBase64Url(jcsBytes(proof));
}

export function decodeIdentityProof(encoded: string): AppIdentityProofV1 {
  const bytes = decodeBase64Url(encoded);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = parseStrictJcs(source);
  return validateIdentityProof(value);
}
