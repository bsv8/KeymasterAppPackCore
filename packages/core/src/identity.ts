import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ERROR_CODES, KeymasterError } from "./errors.js";
import { bytesToHex, hexToBytes, isLowerHex } from "./encoding.js";
import { jcs, jcsBytes } from "./jcs.js";
import { validateAppMetadata } from "./metadata.js";
import type { AppIdentityPayloadV1, AppIdentityProofV1, PublisherSigner } from "./types.js";

const IDENTITY_DOMAIN = new TextEncoder().encode("keymaster-app-identity:v1");

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** 校验身份签名覆盖的完整 metadata payload。 */
export function validateIdentityPayload(value: unknown): AppIdentityPayloadV1 {
  try {
    return validateAppMetadata(value) as AppIdentityPayloadV1;
  } catch (error) {
    if (error instanceof KeymasterError && error.code === ERROR_CODES.METADATA_INVALID)
      throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, error.message, error.context, error);
    throw error;
  }
}

/** 校验 flat identity proof 的字段、编码和 metadata。 */
export function validateIdentityProof(value: unknown): AppIdentityProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity proof must be an object");
  const object = value as Record<string, unknown>;
  if (!exactKeys(object, ["version", "publisherPublicKey", "app", "requirements", "signature"]))
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity proof has unexpected fields");
  const payload = validateIdentityPayload({
    version: object.version,
    publisherPublicKey: object.publisherPublicKey,
    app: object.app,
    requirements: object.requirements,
  });
  if (!isLowerHex(object.signature, 64))
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "identity signature must be 64-byte lowercase hex");
  return { ...payload, signature: object.signature as string };
}

export function identitySigningBytes(payload: AppIdentityPayloadV1): Uint8Array {
  const value = validateIdentityPayload(payload);
  return new Uint8Array([...IDENTITY_DOMAIN, 0, ...jcsBytes(value)]);
}

export function identitySigningDigest(payload: AppIdentityPayloadV1): Uint8Array {
  return sha256(identitySigningBytes(payload));
}

export async function signIdentityProof(
  signer: PublisherSigner,
  payload: AppIdentityPayloadV1,
): Promise<AppIdentityProofV1> {
  const value = validateIdentityPayload(payload);
  const publicKey = await signer.getPublicKey();
  if (publicKey !== value.publisherPublicKey)
    throw new KeymasterError(ERROR_CODES.PUBLISHER_KEY_MISMATCH, "signer public key does not match metadata");
  const signature = await signer.signDigest(identitySigningDigest(value));
  if (signature.length !== 64)
    throw new KeymasterError(ERROR_CODES.IDENTITY_INVALID, "signer returned a non-compact signature");
  const proof = validateIdentityProof({ ...value, signature: bytesToHex(signature) });
  assertIdentityProof(proof);
  return proof;
}

export function verifyIdentityProof(proof: AppIdentityProofV1): boolean {
  const value = validateIdentityProof(proof);
  try {
    const payload: AppIdentityPayloadV1 = {
      version: value.version,
      publisherPublicKey: value.publisherPublicKey,
      app: value.app,
      requirements: value.requirements,
    };
    return secp256k1.verify(
      hexToBytes(value.signature, 64, "identity signature"),
      identitySigningDigest(payload),
      hexToBytes(value.publisherPublicKey, 33, "publisher public key"),
      { prehash: false },
    );
  } catch {
    return false;
  }
}

export function assertIdentityProof(proof: AppIdentityProofV1): void {
  if (!verifyIdentityProof(proof))
    throw new KeymasterError(ERROR_CODES.IDENTITY_SIGNATURE_INVALID, "identity signature verification failed");
}

/** 输出项目根使用的 flat identity proof JSON。 */
export function identityProofJson(proof: AppIdentityProofV1): string {
  const value = validateIdentityProof(proof);
  assertIdentityProof(value);
  return `${jcs(value)}\n`;
}
